import {
  constantString,
  groovyParameters,
  isAstNode,
  isRecord,
  variableName,
  walkAst,
  type AstNode,
  type ParsedGroovyFile,
  type SourceComment,
  type SourceSpan,
} from "./ast.ts";
import { rootDiagnostics } from "./diagnostics.ts";
import {
  ACTION_DISPATCHER,
  ACTION_DISPATCHER_MARKER,
  helperCall,
  helperStatements,
  withActionDispatcher,
  type HelperName,
} from "./helpers.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
import type { ProposalId } from "./proposals.ts";
import { SEXSCRIPT_API_METHODS } from "./sexscript-api.ts";
import {
  BOOLEAN,
  inferType,
  inferVariableTypes,
  LIST,
  NULL,
  NUMBER,
  OBJECT,
  onlyOf,
  STRING,
  type TypeEnvironment,
  UNKNOWN,
} from "./types.ts";
import type {
  MixinModuleInfo,
  IrExpression,
  IrListChoiceOption,
  IrFunctionParameter,
  IrStatement,
  IrSwitchCase,
  LegacyMetadata,
  MigrationDiagnostic,
  MigrationProgram,
} from "./ir.ts";

interface ClosureInfo {
  implicitParameter: boolean;
  minArgs: number;
  maxArgs: number;
}

export interface HelperFunctionInfo {
  minArgs: number;
  maxArgs: number;
  stripsMain: boolean;
}

export type HelperRegistry = ReadonlyMap<string, ReadonlyMap<string, HelperFunctionInfo>>;

export interface LowerOptions {
  helperRegistry?: HelperRegistry;
  /** Functions defined anywhere in the package, such as runtime-loaded mixin methods. */
  packageFunctions?: ReadonlySet<string>;
  /** Runtime-loaded mixin modules of the package. */
  mixinModules?: readonly MixinModuleInfo[];
  /** Names assigned exactly once in the whole package, which no side effect can change afterwards. */
  stableNames?: ReadonlySet<string>;
  /** Value types of package globals defined in other files, such as anonymous-object fields. */
  globalTypes?: ReadonlyMap<string, number>;
  /**
   * Whether the package stops all background sounds somewhere, so background sounds keep their handles. Without
   * package context, the file itself decides.
   */
  stopsBackgroundSounds?: boolean;
  /** Functions whose result some caller uses (packageResultUses); without package context, the file decides. */
  resultUses?: ReadonlySet<string>;
  /** Source names of the package files in each directory, to check that a module loader's directory is complete. */
  directoryFiles?: ReadonlyMap<string, readonly string[]>;
  /**
   * Rename identifiers TeaseScript rejects (default). Package composition disables this per file and renames
   * the composed program once.
   */
  renameIdentifiers?: boolean;
  /** Proposed language changes to emit in their working syntax instead of reporting the construct. */
  proposals?: ReadonlySet<ProposalId>;
}

interface LowerContext {
  diagnostics: MigrationDiagnostic[];
  metadata: LegacyMetadata | null;
  functions: Map<string, ClosureInfo>;
  types: TypeEnvironment;
  /**
   * Statements that must run immediately before the statement being lowered, such as the `say` that shows a
   * legacy input prompt before a compact TeaseScript input expression.
   */
  prelude: IrStatement[];
  /** The Groovy statement being lowered; prelude statements run immediately before it. */
  statementRoot: AstNode | null;
  /**
   * Statements that must run immediately after the statement being lowered, such as the increment of `i++` used as
   * a value. Only a statement lowered directly from a statement list (`postludeRoot`) may add them.
   */
  postlude: IrStatement[];
  postludeRoot: AstNode | null;
  /** Variable nodes that refer to a local variable sharing its name with a closure function. */
  shadowingReferences: ReadonlySet<AstNode>;
  classLoaderVariables: Set<string>;
  legacyHelperClasses: Map<string, string>;
  helperFunctions: Map<string, HelperFunctionInfo>;
  helperMainParameter: string | null;
  packageHelperRegistry: HelperRegistry;
  syntheticHelpers: Set<HelperName>;
  functionDepth: number;
  comments: CommentQueue;
  /** Legacy source lines used to preserve code that needs manual migration. */
  sourceLines: string[];
  /** Diagnostics already rendered as inline notes in the generated output. */
  renderedDiagnostics: Set<MigrationDiagnostic>;
  packageFunctions: ReadonlySet<string>;
  stableNames: ReadonlySet<string>;
  mixinModules: readonly MixinModuleInfo[];
  /** Module directories whose loader this script replaced with direct module calls. */
  loadsModuleDirectories: Set<string>;
  /** Function lowered right now and its parameter/local names, for closure naming and capture checks. */
  currentFunction: {
    name: string;
    locals: ReadonlySet<string>;
    /** The body and parameters, for the names visible at a given point. */
    body?: AstNode;
    parameters?: readonly string[];
  } | null;
  /** Functions generated from closure values, emitted at the program root. */
  closureFunctions: IrStatement[];
  /** Functions referenced by closure-value action IDs; the package dispatcher calls them. */
  actions: Set<string>;
  /** Counter for variables that keep an input result the legacy statement ignored. */
  ignoredInputs: number;
  /** Counter for temporaries that hold a switch value evaluated once for an if chain. */
  switchValues: number;
  /** Counter for variables that keep the start time of a popup whose waiting time is used. */
  popupTimers: number;
  /** Names of generated variables, kept apart from each other and from authored variables. */
  generatedNames: Set<string>;
  stopsBackgroundSounds: boolean;
  resultUses: ReadonlySet<string>;
  directoryFiles: ReadonlyMap<string, readonly string[]>;
  /** Variables assigned once with the current date (`new Date()`, `Calendar.getInstance()`). */
  dateValues: ReadonlySet<string>;
  /** List variables that Groovy shared with another variable by an assignment of one to the other. */
  aliasedLists: ReadonlySet<string>;
  proposals: ReadonlySet<ProposalId>;
}

/** Source comments not yet emitted; shared by every context lowering the same file. */
interface CommentQueue {
  items: SourceComment[];
  next: number;
}

const JAVA_REFLECTION_METHODS = new Set([
  "getConstructor",
  "getDeclaredConstructor",
  "getDeclaredField",
  "getDeclaredMethod",
  "getField",
  "getMethod",
  "invoke",
  "newInstance",
]);

const DIRECT_STORAGE_LOADS = new Set([
  "load",
  "loadBoolean",
  "loadFloat",
  "loadInteger",
  "loadString",
]);

export function buildHelperRegistry(files: readonly ParsedGroovyFile[]): HelperRegistry {
  const registry = new Map<string, ReadonlyMap<string, HelperFunctionInfo>>();
  for (const file of files) {
    const root = file.root;
    if (root?.kind !== "compilationUnit") continue;
    for (const helperClass of nodeArray(root.classes)) {
      const className = text(helperClass.name);
      if (helperClass.kind !== "class" || className === null) continue;
      registry.set(className, collectHelperFunctionInfo(nodeArray(helperClass.methods)));
    }
  }
  return registry;
}

export function lowerParsedFiles(files: readonly ParsedGroovyFile[]): MigrationProgram[] {
  const helperRegistry = buildHelperRegistry(files);
  return files.map((file) => lowerParsedFile(file, { helperRegistry }));
}

export function lowerParsedFile(
  file: ParsedGroovyFile,
  options: LowerOptions = {},
): MigrationProgram {
  const context: LowerContext = {
    diagnostics: [],
    metadata: null,
    functions: new Map(),
    types: { variables: new Map() },
    prelude: [],
    statementRoot: null,
    postlude: [],
    postludeRoot: null,
    shadowingReferences: new Set(),
    classLoaderVariables: new Set(),
    legacyHelperClasses: new Map(),
    helperFunctions: new Map(),
    helperMainParameter: null,
    packageHelperRegistry: options.helperRegistry ?? new Map(),
    syntheticHelpers: new Set(),
    functionDepth: 0,
    comments: { items: file.comments ?? [], next: 0 },
    sourceLines: file.source === undefined ? [] : file.source.split(/\r\n?|\n/u),
    renderedDiagnostics: new Set(),
    packageFunctions: options.packageFunctions ?? new Set(),
    stableNames: options.stableNames ?? new Set(),
    mixinModules: options.mixinModules ?? [],
    loadsModuleDirectories: new Set(),
    currentFunction: null,
    closureFunctions: [],
    actions: new Set(),
    ignoredInputs: 0,
    switchValues: 0,
    popupTimers: 0,
    generatedNames: new Set(),
    stopsBackgroundSounds: options.stopsBackgroundSounds ?? packageStopsBackgroundSounds([file]),
    resultUses: options.resultUses ?? packageResultUses([file]),
    directoryFiles: options.directoryFiles ?? new Map(),
    dateValues: new Set(),
    aliasedLists: new Set(),
    proposals: options.proposals ?? new Set(),
  };
  if (file.diagnostics.length > 0 || file.root === null) {
    for (const diagnostic of file.diagnostics) {
      context.diagnostics.push({
        code: diagnostic.code,
        severity: "error",
        message: diagnostic.message,
        span: null,
      });
    }
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: context.diagnostics,
    };
  }

  if (file.root.kind === "compilationUnit") return lowerHelperCompilationUnit(file, context);
  if (file.root.kind !== "scriptBody") {
    context.diagnostics.push({
      code: "SX_UNIT_LOWERING_DEFERRED",
      severity: "error",
      message: "Non-script Groovy input is parsed but not lowered by the importer.",
      span: file.root.span,
    });
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: context.diagnostics,
    };
  }

  const rawBody = asNode(file.root.body);
  const mixin = rawBody === null ? null : desugarMixinModule(rawBody, file.sourceName);
  const body = mixin?.body ?? desugarObjectScript(rawBody, nodeArray(file.root.classes), context);
  if (body?.kind === "block") {
    context.functions = collectClosureInfo(body);
    context.shadowingReferences = collectShadowingReferences(body, context.functions);
    context.types = withGlobalTypes(
      inferVariableTypes(body, [], context.packageFunctions),
      options.globalTypes,
    );
    context.dateValues = currentDateVariables(body, context.types);
    context.aliasedLists = aliasedListVariables(body, context.types);
    const helpers = collectLegacyHelperBindings(body);
    context.classLoaderVariables = helpers.classLoaders;
    context.legacyHelperClasses = helpers.helperClasses;
  }
  const authoredStatements = withoutTrailingEnd(
    body?.kind === "block" ? lowerBlock(body, context) : [],
  );
  const statements = [
    ...helperStatements(context.syntheticHelpers),
    ...context.closureFunctions,
    ...authoredStatements,
  ];
  if (body?.kind !== "block") {
    addDiagnostic(
      context,
      "SX_INVALID_SCRIPT_BODY",
      "error",
      "Parser output does not contain a script body block.",
      file.root.span,
    );
  }

  const program: MigrationProgram = {
    sourceName: file.sourceName,
    metadata: context.metadata,
    statements,
    diagnostics: context.diagnostics,
    ...(mixin === null ? {} : { module: mixin.info }),
    ...(context.actions.size === 0 ? {} : { actions: [...context.actions] }),
    ...(context.loadsModuleDirectories.size === 0
      ? {}
      : { loadsModuleDirectories: [...context.loadsModuleDirectories].sort() }),
  };
  if (options.renameIdentifiers === false) return program;
  return renameConflictingIdentifiers(withActionDispatcher(program));
}

function lowerHelperCompilationUnit(
  file: ParsedGroovyFile,
  baseContext: LowerContext,
): MigrationProgram {
  const root = file.root;
  if (root === null || root.kind !== "compilationUnit") {
    throw new Error("lowerHelperCompilationUnit requires a compilation unit");
  }
  const topLevel = asNode(root.topLevel);
  if (topLevel !== null && topLevel.kind === "block" && nodeArray(topLevel.statements).length > 0) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_TOP_LEVEL_CODE",
      "error",
      "Auxiliary Groovy helper units with executable top-level code require manual migration.",
      topLevel.span,
    );
  }
  const classes = nodeArray(root.classes);
  if (classes.length !== 1) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_CLASS_COUNT",
      "error",
      `Expected one auxiliary helper class, found ${classes.length}.`,
      root.span,
    );
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: baseContext.diagnostics,
    };
  }
  const helperClass = classes[0]!;
  const fields = nodeArray(helperClass.fields);
  if (fields.length > 0) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_SHARED_STATE",
      "error",
      "Auxiliary Groovy helper classes with fields may carry shared or static state and require explicit migration.",
      helperClass.span,
    );
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: baseContext.diagnostics,
    };
  }
  const methods = nodeArray(helperClass.methods);
  const helperFunctions = collectHelperFunctionInfo(methods);
  const statements: IrStatement[] = [];
  for (const method of methods) {
    const leadingComments = takeCommentsBefore(baseContext, method.span).map(
      (comment) => comment.text,
    );
    const lowered = lowerHelperMethod(method, baseContext, helperFunctions);
    if (lowered === null) continue;
    if (lowered.kind === "function" && leadingComments.length > 0)
      lowered.leadingComments = leadingComments;
    statements.push(lowered);
  }
  return {
    sourceName: file.sourceName,
    metadata: null,
    statements: [...helperStatements(baseContext.syntheticHelpers), ...statements],
    diagnostics: baseContext.diagnostics,
  };
}

function collectHelperFunctionInfo(methods: AstNode[]): Map<string, HelperFunctionInfo> {
  const result = new Map<string, HelperFunctionInfo>();
  for (const method of methods) {
    const name = text(method.name);
    if (method.kind !== "method" || name === null) continue;
    const parameters = groovyParameters(method.parameters) ?? [];
    const stripsMain = parameters[0]?.name === "main";
    const authored = stripsMain ? parameters.slice(1) : parameters;
    const minArgs = authored.filter((parameter) => parameter.defaultValue === null).length;
    result.set(name, { minArgs, maxArgs: authored.length, stripsMain });
  }
  return result;
}

function lowerHelperMethod(
  method: AstNode,
  baseContext: LowerContext,
  helperFunctions: Map<string, HelperFunctionInfo>,
): IrStatement | null {
  const name = text(method.name);
  if (method.kind !== "method" || name === null) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_METHOD",
      "error",
      "Auxiliary helper contains an invalid method.",
      method.span,
    );
    return null;
  }
  const records = groovyParameters(method.parameters);
  if (records === null) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_PARAMETER",
      "error",
      `Helper method ${name} has an invalid parameter.`,
      method.span,
    );
    return null;
  }
  const stripsMain = records[0]?.name === "main";
  const authoredRecords = stripsMain ? records.slice(1) : records;
  const body = asNode(method.body);
  if (body?.kind !== "block") {
    addDiagnostic(
      baseContext,
      "SX_HELPER_BODY",
      "error",
      `Helper method ${name} does not contain a normal block body.`,
      method.span,
    );
    return null;
  }
  const context: LowerContext = {
    diagnostics: baseContext.diagnostics,
    metadata: baseContext.metadata,
    functions: collectClosureInfo(body),
    types: inferVariableTypes(
      body,
      authoredRecords.map((parameter) => parameter.name),
      helperFunctions.keys(),
    ),
    prelude: [],
    statementRoot: null,
    postlude: [],
    postludeRoot: null,
    shadowingReferences: collectShadowingReferences(body, collectClosureInfo(body)),
    classLoaderVariables: new Set(),
    legacyHelperClasses: new Map(),
    helperFunctions,
    helperMainParameter: stripsMain ? "main" : null,
    packageHelperRegistry: baseContext.packageHelperRegistry,
    syntheticHelpers: baseContext.syntheticHelpers,
    functionDepth: 1,
    comments: baseContext.comments,
    sourceLines: baseContext.sourceLines,
    renderedDiagnostics: baseContext.renderedDiagnostics,
    packageFunctions: baseContext.packageFunctions,
    stableNames: baseContext.stableNames,
    mixinModules: baseContext.mixinModules,
    loadsModuleDirectories: baseContext.loadsModuleDirectories,
    stopsBackgroundSounds: baseContext.stopsBackgroundSounds,
    resultUses: baseContext.resultUses,
    directoryFiles: baseContext.directoryFiles,
    dateValues: new Set(),
    aliasedLists: new Set(),
    proposals: baseContext.proposals,
    currentFunction: {
      name,
      locals: functionLocalNames(
        body,
        authoredRecords.map((parameter) => parameter.name),
      ),
    },
    closureFunctions: baseContext.closureFunctions,
    actions: baseContext.actions,
    ignoredInputs: 0,
    switchValues: 0,
    popupTimers: 0,
    generatedNames: new Set(),
  };
  const parameters: IrFunctionParameter[] = [];
  for (const parameter of authoredRecords) {
    const parameterName = parameter.name;
    const initial = parameter.defaultValue;
    const defaultValue = initial === null ? null : lowerExpression(initial, context);
    if (initial !== null && defaultValue === null) {
      addDiagnostic(
        context,
        "SX_HELPER_PARAMETER_DEFAULT",
        "error",
        `Default value for helper parameter ${parameterName} could not be migrated.`,
        method.span,
      );
    }
    parameters.push({ name: parameterName, defaultValue });
  }
  return {
    kind: "function",
    name,
    parameters,
    body: lowerBlock(
      method.returnType === "void" || !context.resultUses.has(name)
        ? body
        : withImplicitReturn(body, context),
      context,
    ),
    span: method.span,
  };
}

function lowerBlock(block: AstNode, context: LowerContext): IrStatement[] {
  return lowerStatementList(nodeArray(block.statements), block.span, context);
}

/** Lowers statements in source order and interleaves the comments that precede or follow them. */
function lowerStatementList(
  statements: AstNode[],
  enclosingSpan: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const result: IrStatement[] = [];
  let previousEndLine: number | null = null;
  const emitComments = (comments: SourceComment[]): void => {
    for (const comment of comments) {
      result.push(...paragraphBreak(context, previousEndLine, comment.line));
      result.push(commentStatement(comment, previousEndLine));
      previousEndLine = comment.endLine;
    }
  };
  for (const statement of statements) {
    const span = statementSpan(statement);
    emitComments(takeCommentsBefore(context, span));
    if (span !== null) result.push(...paragraphBreak(context, previousEndLine, span.line));
    const firstDiagnostic = context.diagnostics.length;
    const [prelude, lowered, postlude] = withSurroundings(context, statement);
    const only = lowered.length === 1 ? lowered[0] : undefined;
    if (only?.kind === "unsupported" && span !== null) {
      only.legacySource = legacySourceLines(context, span);
    }
    result.push(...diagnosticNotes(context, firstDiagnostic), ...prelude, ...lowered, ...postlude);
    if (span !== null) previousEndLine = span.endLine;
  }
  emitComments(takeCommentsBefore(context, enclosingSpan === null ? null : endOf(enclosingSpan)));
  return result;
}

/** Keeps one blank line where the legacy source separated statements or comments by blank lines. */
function paragraphBreak(
  context: LowerContext,
  previousEndLine: number | null,
  nextLine: number,
): IrStatement[] {
  if (previousEndLine === null || nextLine <= previousEndLine + 1) return [];
  const gap = context.sourceLines.slice(previousEndLine, nextLine - 1);
  return gap.length > 0 && gap.every((line) => line.trim() === "")
    ? [{ kind: "blank", span: null }]
    : [];
}

/** A legacy `return null` on the last line only ends the script, which reaching the end already does. */
function withoutTrailingEnd(statements: IrStatement[]): IrStatement[] {
  const lastCode = statements.findLastIndex(
    (statement) => statement.kind !== "comment" && statement.kind !== "blank",
  );
  if (statements[lastCode]?.kind !== "end") return statements;
  // A trailing comment of the removed statement must not attach to the previous one.
  return statements
    .toSpliced(lastCode, 1)
    .map((statement, index) =>
      index >= lastCode && statement.kind === "comment"
        ? { ...statement, trailing: false }
        : statement,
    );
}

/** Like withPrelude, with `root` as the evaluation point for prompt placement. */
function withStatementRoot<T>(
  context: LowerContext,
  root: AstNode,
  lower: () => T,
): [IrStatement[], T] {
  const outerRoot = context.statementRoot;
  context.statementRoot = root;
  try {
    return withPrelude(context, lower);
  } finally {
    context.statementRoot = outerRoot;
  }
}

/** Lowers one statement of a statement list with the statements that must run right before and after it. */
function withSurroundings(
  context: LowerContext,
  statement: AstNode,
): [IrStatement[], IrStatement[], IrStatement[]] {
  const outer = { postlude: context.postlude, root: context.postludeRoot };
  context.postlude = [];
  context.postludeRoot = statement;
  try {
    const [prelude, lowered] = withPrelude(context, () => lowerStatement(statement, context));
    return [prelude, lowered, context.postlude];
  } finally {
    context.postlude = outer.postlude;
    context.postludeRoot = outer.root;
  }
}

/** Runs `lower` with an empty prelude and returns the prelude statements it produced. */
function withPrelude<T>(context: LowerContext, lower: () => T): [IrStatement[], T] {
  const outer = context.prelude;
  context.prelude = [];
  try {
    const result = lower();
    return [context.prelude, result];
  } finally {
    context.prelude = outer;
  }
}

/** Groovy omits positions on some expression statements; fall back to the expression. */
function statementSpan(node: AstNode): SourceSpan | null {
  return node.span ?? asNode(node.expression)?.span ?? null;
}

function endOf(span: SourceSpan): SourceSpan {
  return {
    line: span.endLine,
    column: span.endColumn,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}

function takeCommentsBefore(context: LowerContext, span: SourceSpan | null): SourceComment[] {
  if (span === null) return [];
  const queue = context.comments;
  const start = queue.next;
  while (queue.next < queue.items.length) {
    const comment = queue.items[queue.next]!;
    const before =
      comment.line < span.line || (comment.line === span.line && comment.column < span.column);
    if (!before) break;
    queue.next += 1;
  }
  return queue.items.slice(start, queue.next);
}

function commentStatement(comment: SourceComment, previousEndLine: number | null): IrStatement {
  return {
    kind: "comment",
    text: comment.text.replace(/\r\n?/gu, "\n"),
    trailing: previousEndLine !== null && comment.line === previousEndLine,
    span: {
      line: comment.line,
      column: comment.column,
      endLine: comment.endLine,
      endColumn: comment.column,
    },
  };
}

function lowerStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const outerRoot = context.statementRoot;
  context.statementRoot = node;
  try {
    return lowerStatementNode(node, context);
  } finally {
    context.statementRoot = outerRoot;
  }
}

function lowerStatementNode(node: AstNode, context: LowerContext): IrStatement[] {
  if (
    node.kind === "importerNote" &&
    typeof node.code === "string" &&
    typeof node.message === "string"
  ) {
    // Placed by an AST desugaring so the explanation renders next to the rewritten code.
    addDiagnostic(context, node.code, "warning", node.message, node.span);
    return [];
  }
  const conditional = lowerConditionalStatement(node, context);
  if (conditional !== null) return conditional;
  switch (node.kind) {
    case "empty":
      return [];
    case "expressionStatement":
      return lowerExpressionStatement(node, context);
    case "if":
      return lowerIf(node, context);
    case "while":
      return lowerWhile(node, context);
    case "for":
      return lowerFor(node, context);
    case "switch":
      return lowerSwitch(node, context);
    case "return":
      return lowerReturnStatement(node, context);
    case "break":
    case "continue":
      if (typeof node.label === "string") {
        return [
          unsupportedStatement(
            context,
            node,
            "SX_LABELLED_JUMP",
            `${node.kind} ${node.label} leaves an outer labelled loop; TeaseScript ${node.kind} affects only the innermost loop. Restructure the loops, for example with a flag.`,
          ),
        ];
      }
      return [{ kind: node.kind, span: node.span }];
    default:
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_STATEMENT",
          `Unsupported Groovy statement: ${node.kind}`,
        ),
      ];
  }
}

/**
 * TeaseScript has no conditional expression. A statement containing a Groovy ternary or Elvis expression is
 * rewritten into an `if` before lowering: a conditional variable value becomes one assignment per branch, and
 * any other statement is repeated in both branches so nested conditionals become `else if` chains.
 */
function lowerConditionalStatement(node: AstNode, context: LowerContext): IrStatement[] | null {
  if (node.kind !== "expressionStatement" && node.kind !== "return") return null;
  const root = asNode(node.kind === "return" ? node.value : node.expression);
  const conditional = root === null ? null : findConditional(root);
  if (root === null || conditional === null) return null;
  const span = node.span;

  const isAssignment =
    root.kind === "declaration" || (root.kind === "binary" && root.operator === "=");
  const target = isAssignment ? asNode(root.left) : null;
  if (target !== null && variableName(target) !== null && asNode(root.right) === conditional) {
    return lowerConditionalAssignment(
      root.kind === "declaration",
      target,
      conditional,
      span,
      context,
    );
  }

  // Repeating the statement per branch evaluates the condition first, which is only equivalent when nothing
  // with side effects runs earlier in the statement and the conditional is not behind && / || / ?: guards.
  const hoistedCondition = asNode(
    conditional.kind === "ternary" ? conditional.condition : conditional.boolean,
  );
  if (hoistedCondition === null || !isHoistable(node, conditional, context, hoistedCondition)) {
    return [
      unsupportedStatement(
        context,
        conditional,
        "SX_CONDITIONAL_POSITION",
        "This conditional expression cannot be evaluated first without changing behavior: it is guarded by && / || / ?:, follows side effects, or has side effects that values read earlier in the statement would observe. Rewrite it with an explicit if.",
      ),
    ];
  }
  if (target !== null && variableName(target) !== null && root.kind === "declaration") {
    // Declare in the enclosing scope first, then assign per branch, so the variable stays visible afterwards.
    return [
      ...lowerStatement(
        syntheticAssignment(true, target, syntheticConstant(null, span), span),
        context,
      ),
      ...lowerStatement(syntheticAssignment(false, target, asNode(root.right)!, span), context),
    ];
  }
  const split = splitConditional(conditional);
  if (split === null) return null;
  return lowerStatement(
    syntheticIf(
      split.condition,
      substituteNode(node, conditional, split.whenTrue),
      substituteNode(node, conditional, split.whenFalse),
      span,
    ),
    context,
  );
}

function lowerConditionalAssignment(
  declaration: boolean,
  target: AstNode,
  conditional: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const assign = (value: AstNode): AstNode => syntheticAssignment(declaration, target, value, span);
  const update = (value: AstNode): AstNode => syntheticAssignment(false, target, value, span);
  if (conditional.kind === "elvis") {
    const value = asNode(conditional.boolean);
    const fallback = asNode(conditional.false);
    if (value === null || fallback === null) return [];
    // `x = x ?: d` needs no self-assignment before the check.
    const reassignsSelf = !declaration && variableName(value) === variableName(target);
    const stored = lowerStatement(assign(value), context);
    const fill = lowerStatement(update(fallback), context);
    // The check sees the value just stored, whose type can include null even when the variable's
    // overall type does not.
    const variable: IrExpression = { kind: "variable", name: variableName(target)! };
    const truthy = truthiness(variable, inferType(value, context.types), true, target, context);
    if (truthy === null) {
      const legacySource = span === null ? [] : legacySourceLines(context, span);
      return [{ kind: "unsupported", legacySource, span }];
    }
    return [
      ...(reassignsSelf ? [] : stored),
      { kind: "if", condition: negate(truthy), then: fill, else: [], span },
    ];
  }
  const condition = asNode(conditional.condition);
  const whenTrue = asNode(conditional.true);
  const whenFalse = asNode(conditional.false);
  if (condition === null || whenTrue === null || whenFalse === null) return [];
  if (!declaration) {
    return lowerStatement(
      syntheticIf(condition, update(whenTrue), update(whenFalse), span),
      context,
    );
  }
  // Start from a constant branch value so the result reads like ordinary TeaseScript; a variable could be
  // changed by the condition, so it is only read inside its branch.
  if (isSimpleValue(whenFalse)) {
    return [
      ...lowerStatement(assign(whenFalse), context),
      ...lowerStatement(syntheticIf(condition, update(whenTrue), null, span), context),
    ];
  }
  if (isSimpleValue(whenTrue)) {
    return [
      ...lowerStatement(assign(whenTrue), context),
      ...lowerStatement(
        syntheticIf(syntheticNot(condition), update(whenFalse), null, span),
        context,
      ),
    ];
  }
  return [
    ...lowerStatement(assign(syntheticConstant(null, span)), context),
    ...lowerStatement(syntheticIf(condition, update(whenTrue), update(whenFalse), span), context),
  ];
}

/** Returns the condition and branch values; an Elvis operand must be repeatable to serve as both. */
function splitConditional(
  conditional: AstNode,
): { condition: AstNode; whenTrue: AstNode; whenFalse: AstNode } | null {
  if (conditional.kind === "ternary") {
    const condition = asNode(conditional.condition);
    const whenTrue = asNode(conditional.true);
    const whenFalse = asNode(conditional.false);
    return condition === null || whenTrue === null || whenFalse === null
      ? null
      : { condition, whenTrue, whenFalse };
  }
  const value = asNode(conditional.boolean);
  const fallback = asNode(conditional.false);
  if (value === null || fallback === null) return null;
  if (!isRepeatableExpression(value)) return null;
  return { condition: value, whenTrue: value, whenFalse: fallback };
}

/** First ternary or Elvis expression in evaluation order, ignoring closure bodies. */
function findConditional(node: AstNode): AstNode | null {
  if (node.kind === "ternary" || node.kind === "elvis") return node;
  if (node.kind === "closure") return null;
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!isAstNode(child)) continue;
      const found = findConditional(child);
      if (found !== null) return found;
    }
  }
  return null;
}

function substituteNode(value: AstNode, target: AstNode, replacement: AstNode): AstNode {
  if (value === target) return replacement;
  const result: AstNode = { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (isAstNode(child)) result[key] = substituteNode(child, target, replacement);
    else if (Array.isArray(child)) {
      result[key] = child.map((item) =>
        isAstNode(item) ? substituteNode(item, target, replacement) : item,
      );
    }
  }
  return result;
}

/** Constant values that are safe and readable as an unconditional initial value. */
function isSimpleValue(node: AstNode): boolean {
  if (node.kind === "constant") return true;
  if (node.kind === "unaryMinus") return asNode(node.value)?.kind === "constant";
  if (node.kind === "list") return nodeArray(node.items).every(isSimpleValue);
  return false;
}

/**
 * Whether `target` may be evaluated (or have its prompt shown) at the start of statement `root` without
 * changing behavior: it must not sit behind a short-circuit or conditional guard, and nothing with side effects
 * may be evaluated before it. Closure bodies are not evaluated in place.
 */
function isHoistable(
  root: AstNode,
  target: AstNode,
  context: LowerContext,
  hoisted: AstNode = target,
): boolean {
  // A hoisted part with side effects must also not run before values the statement read earlier.
  const hoistedHasEffects = !isPure(hoisted, context);
  let effectsBefore = false;
  let readsBefore = false;
  let result: boolean | null = null;
  const visit = (node: AstNode, guarded: boolean): boolean => {
    if (node === target) {
      result = !guarded && !effectsBefore && !(hoistedHasEffects && readsBefore);
      return true;
    }
    if (node.kind === "closure") return false;
    const guardedChildren = new Set<unknown>();
    if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
      guardedChildren.add(node.right);
    } else if (node.kind === "ternary") {
      guardedChildren.add(node.true);
      guardedChildren.add(node.false);
    } else if (node.kind === "elvis") {
      guardedChildren.add(node.false);
    }
    // A plain assignment target is written after the value is computed, not read before it.
    const assignsVariable =
      (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) &&
      asNode(node.left)?.kind === "variable";
    for (const [key, value] of Object.entries(node)) {
      if (key === "span" || (key === "left" && assignsVariable)) continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (isAstNode(child) && visit(child, guarded || guardedChildren.has(value))) return true;
      }
    }
    if (hasOwnEffect(node, context)) effectsBefore = true;
    // The implicit receiver and variables assigned only by their declaration cannot change.
    const name = node.kind === "variable" ? variableName(node) : null;
    const stable =
      name === "this" ||
      (name !== null &&
        (context.types.singleAssignment?.has(name) === true || context.stableNames.has(name)));
    if ((node.kind === "variable" && !stable) || node.kind === "property") readsBefore = true;
    return false;
  };
  visit(root, false);
  return result === true;
}

/** The SexScript API call this node makes, unless a package function with that name shadows the API. */
function legacyApiCall(
  node: AstNode,
  context: LowerContext,
): { name: string; arguments: AstNode[] } | null {
  const call = callParts(node);
  if (call === null || !call.inherited) return null;
  const shadowed =
    context.functions.has(call.name) ||
    context.packageFunctions.has(call.name) ||
    context.helperFunctions.has(call.name) ||
    isVisibleLocal(call.name, node, context);
  return shadowed ? null : call;
}

/** Whether a parameter or local of the current function, visible at `node`, has this name. */
function isVisibleLocal(name: string, node: AstNode, context: LowerContext): boolean {
  const enclosing = context.currentFunction;
  if (enclosing?.locals.has(name) !== true) return false;
  return (
    enclosing.body === undefined ||
    visibleLocals(enclosing.body, enclosing.parameters ?? [], node)?.has(name) !== false
  );
}

function hasOwnEffect(node: AstNode, context: LowerContext): boolean {
  if (node.kind === "postfix" || node.kind === "prefix" || node.kind === "constructorCall")
    return true;
  if (node.kind === "binary" && typeof node.operator === "string") {
    // `list << x` appends to the list.
    if (node.operator === "<<") return true;
    return node.operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(node.operator);
  }
  if (node.kind !== "methodCall") return false;
  const call = callParts(node);
  if (call === null) return true;
  if (call.inherited) return !DIRECT_STORAGE_LOADS.has(legacyApiCall(node, context)?.name ?? "");
  return !PURE_OBJECT_METHODS.has(call.name);
}

const PURE_OBJECT_METHODS = new Set([
  "contains",
  "equals",
  "isEmpty",
  "length",
  "size",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
]);

/** Expressions without interactions, randomness, waits, or writes, so they may be evaluated earlier. */
function isPure(node: AstNode, context: LowerContext): boolean {
  const pure = (child: AstNode): boolean => isPure(child, context);
  if (node.kind === "methodCall") {
    const call = callParts(node);
    if (call === null) return false;
    const pureCall = call.inherited
      ? DIRECT_STORAGE_LOADS.has(legacyApiCall(node, context)?.name ?? "")
      : PURE_OBJECT_METHODS.has(call.name);
    const target = asNode(node.object);
    return (
      pureCall && (call.inherited || target === null || pure(target)) && call.arguments.every(pure)
    );
  }
  if (node.kind === "binary" && node.operator === "<<") return false;
  if (node.kind === "binary" && typeof node.operator === "string" && node.operator.endsWith("=")) {
    return ["==", "!=", "<=", ">="].includes(node.operator) && nodeChildren(node).every(pure);
  }
  const pureKinds = new Set([
    "binary",
    "boolean",
    "cast",
    "constant",
    "elvis",
    "gstring",
    "list",
    "map",
    "mapEntry",
    "not",
    "property",
    "range",
    "ternary",
    "unaryMinus",
    "unaryPlus",
    "variable",
  ]);
  return pureKinds.has(node.kind) && nodeChildren(node).every(pure);
}

function nodeChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "span") continue;
    if (isAstNode(value)) children.push(value);
    else if (Array.isArray(value)) children.push(...value.filter(isAstNode));
  }
  return children;
}

function syntheticAssignment(
  declaration: boolean,
  target: AstNode,
  value: AstNode,
  span: SourceSpan | null,
): AstNode {
  const expression = declaration
    ? { kind: "declaration", span, left: target, right: value }
    : { kind: "binary", span, operator: "=", left: target, right: value };
  return { kind: "expressionStatement", span, expression };
}

function syntheticIf(
  condition: AstNode,
  then: AstNode,
  otherwise: AstNode | null,
  span: SourceSpan | null,
): AstNode {
  return { kind: "if", span, condition, then, else: otherwise ?? { kind: "empty", span } };
}

function syntheticNot(value: AstNode): AstNode {
  return { kind: "not", span: value.span, value };
}

function syntheticConstant(value: boolean | null, span: SourceSpan | null): AstNode {
  return { kind: "constant", span, value };
}

function lowerExpressionStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const expression = asNode(node.expression);
  if (expression === null)
    return [unsupportedStatement(context, node, "SX_MISSING_EXPRESSION", "Missing expression.")];

  if (expression.kind === "declaration") return lowerDeclaration(expression, node.span, context);
  if (
    expression.kind !== "methodCall" &&
    !isUncalledClosure(expression, context) &&
    isPure(expression, context)
  ) {
    addDiagnostic(
      context,
      "SX_DISCARDED_VALUE",
      "warning",
      "Groovy computed this value and discarded it, so the statement had no effect and is dropped. A comparison (==) here is often a mistake for an assignment (=).",
      node.span,
    );
    return [];
  }
  if (expression.kind === "binary") return lowerAssignment(expression, node.span, context);
  if (expression.kind === "postfix") return lowerPostfix(expression, node.span, context);
  if (expression.kind === "methodCall") return lowerCallStatement(expression, node.span, context);

  if (isUncalledClosure(expression, context)) {
    addDiagnostic(
      context,
      "SX_CLOSURE_NOT_CALLED",
      "warning",
      `Dropped the bare reference to closure ${variableName(expression)}: without () Groovy did not call it, so it had no effect. Add ${variableName(expression)}() manually if a call was intended.`,
      node.span,
    );
    return [];
  }
  const lowered = lowerExpression(expression, context);
  if (lowered === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_EXPRESSION_STATEMENT",
        "Expression statement could not be migrated safely.",
      ),
    ];
  }
  return [{ kind: "expression", expression: lowered, span: node.span }];
}

function lowerDeclaration(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const name = variableName(node.left);
  const right = asNode(node.right);
  if (name === null || right === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_DECLARATION",
        "Only single-variable declarations are supported.",
      ),
    ];
  }
  if (right.kind === "closure") return lowerClosureDeclaration(name, right, span, context);
  if (context.classLoaderVariables.has(name) && isGroovyClassLoaderConstructor(right)) {
    addDiagnostic(
      context,
      "SX_LEGACY_HELPER_SETUP",
      "info",
      `Removed GroovyClassLoader setup variable ${name}; helper source is migrated separately.`,
      span,
    );
    return [];
  }
  const helperClass = context.legacyHelperClasses.get(name);
  if (helperClass !== undefined && isLegacyLoadClassCall(right, context.classLoaderVariables)) {
    addDiagnostic(
      context,
      "SX_LEGACY_HELPER_SETUP",
      "info",
      `Removed loadClass setup for ${helperClass}; helper calls remain explicit migration candidates.`,
      span,
    );
    return [];
  }
  // A non-closure declaration that shares a closure's name is a nested local in Groovy; naming renames it.
  const collectionLoop = lowerCollectionAssignment(true, name, right, span, context);
  if (collectionLoop !== null) return collectionLoop;
  // `def x` without an initializer starts as null in Groovy; primitive declarations start at 0 or false.
  const declaredType = text(asNode(node.left)?.originType) ?? "";
  const value = isEmptyGroovyExpression(right)
    ? { kind: "literal" as const, value: PRIMITIVE_DEFAULTS.get(declaredType) ?? null }
    : lowerExpression(right, context);
  if (value === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_DECLARATION_VALUE",
        `Cannot safely migrate initializer for ${name}.`,
      ),
    ];
  }
  const optionalType =
    value.kind === "literal" && value.value === null ? nullableValueType(name, context) : null;
  return [{ kind: "let", name, value, span, ...(optionalType === null ? {} : { optionalType }) }];
}

/**
 * The type a null-initialized variable later receives when the evidence is unambiguous, such as `string` or
 * `string[]` (the emitted declaration adds `?`).
 */
function nullableValueType(name: string, context: LowerContext): string | null {
  const type = context.types.variables.get(name);
  if (type === undefined) return null;
  const scalar = (value: number): string | null => {
    if (onlyOf(value, STRING | NULL) && value & STRING) return "string";
    if (onlyOf(value, NUMBER | NULL) && value & NUMBER) return "number";
    if (onlyOf(value, BOOLEAN | NULL) && value & BOOLEAN) return "boolean";
    return null;
  };
  if (onlyOf(type, LIST | NULL) && type & LIST) {
    const elements = context.types.listElements?.get(name);
    const element = elements === undefined || elements & NULL ? null : scalar(elements);
    return element === null ? null : `${element}[]`;
  }
  return scalar(type);
}

function isEmptyGroovyExpression(node: AstNode): boolean {
  return (
    node.kind === "unsupportedExpression" &&
    node.groovyType === "org.codehaus.groovy.ast.expr.EmptyExpression"
  );
}

function lowerClosureDeclaration(
  name: string,
  closure: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (context.functionDepth !== 0) {
    // A closure stored in a local variable inside a function becomes an action ID called via the dispatcher.
    const value = lowerClosureValue(closure, context, name);
    return value === null
      ? [
          unsupportedStatement(
            context,
            closure,
            "SX_NESTED_CLOSURE",
            "Nested Groovy closures are not lowered automatically.",
          ),
        ]
      : [{ kind: "let", name, value, span }];
  }
  const info = context.functions.get(name);
  if (info === undefined) {
    return [
      unsupportedStatement(
        context,
        closure,
        "SX_CLOSURE_DISCOVERY",
        `Closure ${name} was not discovered during the prepass.`,
      ),
    ];
  }

  const parameters: IrFunctionParameter[] = [];
  if (info.implicitParameter) {
    // Callers in other files may pass `it`, so a body that reads it declares it.
    if (info.maxArgs === 1 || readsOwnIt(closure))
      parameters.push({ name: "it", defaultValue: { kind: "literal", value: null } });
  } else {
    const closureParameters = groovyParameters(closure.parameters);
    if (closureParameters === null) {
      return [
        unsupportedStatement(
          context,
          closure,
          "SX_CLOSURE_PARAMETER",
          `Closure ${name} has an invalid parameter.`,
        ),
      ];
    }
    if (defaultBeforeRequired(closureParameters)) {
      return [
        unsupportedStatement(
          context,
          closure,
          "SX_PARAMETER_DEFAULT_ORDER",
          `Closure ${name} gives a parameter a default before a parameter without one; Groovy then fills the required parameters first, which TeaseScript parameters cannot express. Reorder the parameters.`,
        ),
      ];
    }
    for (const record of closureParameters) {
      const defaultNode = record.defaultValue;
      const defaultValue = defaultNode === null ? null : lowerExpression(defaultNode, context);
      if (defaultNode !== null && defaultValue === null) {
        return [
          unsupportedStatement(
            context,
            closure,
            "SX_CLOSURE_PARAMETER_DEFAULT",
            `Default value for ${record.name} could not be migrated.`,
          ),
        ];
      }
      parameters.push({ name: record.name, defaultValue });
    }
  }

  const body = asNode(closure.body);
  if (body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        closure,
        "SX_CLOSURE_BODY",
        `Closure ${name} does not contain a normal block body.`,
      ),
    ];
  }
  const outerFunction = context.currentFunction;
  context.currentFunction = {
    name,
    locals: functionLocalNames(
      body,
      parameters.map((parameter) => parameter.name),
    ),
    body,
    parameters: parameters.map((parameter) => parameter.name),
  };
  context.functionDepth += 1;
  try {
    return [
      {
        kind: "function",
        name,
        parameters,
        body: lowerBlock(
          closure.implicitReturn === false || !context.resultUses.has(name)
            ? body
            : withImplicitReturn(body, context),
          context,
        ),
        span,
      },
    ];
  } finally {
    context.functionDepth -= 1;
    context.currentFunction = outerFunction;
  }
}

const INPUT_CALLS = new Set([
  "getBoolean",
  "getFloat",
  "getInteger",
  "getSelectedValue",
  "getString",
]);

/** SexScript API calls that produce no value, so a trailing call stays a statement. */
const VOID_API_CALLS = new Set([
  "exit",
  "openCdTrays",
  "playBackgroundSound",
  "playSound",
  "save",
  "send",
  "setImage",
  "setInfos",
  "show",
  "sleep",
  "stopSoundThreads",
  "useEmailAddress",
  "useFile",
  "useUrl",
  "wait",
  "waitWithGauge",
]);

/** Collection calls used for their effect, whose trailing use is not a meaningful return value. */
const EFFECT_COLLECTION_CALLS = new Set([
  "add",
  "clear",
  "each",
  "eachWithIndex",
  "forEach",
  "push",
  "remove",
  "times",
]);

/**
 * Groovy closures and methods return the value of their last expression, including the last expression of each
 * `if`/`else` branch and of each `switch` case that ends with `break`. Makes those returns explicit for functions
 * whose result some caller uses; value-less API calls stay statements. A final assignment or declaration returns
 * the assigned variable; other final forms whose value Groovy returned get a note.
 */
function withImplicitReturn(block: AstNode, context: LowerContext): AstNode {
  const statements = nodeArray(block.statements);
  const last = statements.at(-1);
  if (last === undefined) return block;
  return { ...block, statements: [...statements.slice(0, -1), ...implicitReturn(last, context)] };
}

function implicitReturn(statement: AstNode, context: LowerContext): AstNode[] {
  const span = statement.span;
  const branch = (node: AstNode): AstNode => {
    const replaced = implicitReturn(node, context);
    return replaced.length === 1
      ? replaced[0]!
      : { kind: "block", span: node.span, statements: replaced };
  };
  if (statement.kind === "block") return [withImplicitReturn(statement, context)];
  if (statement.kind === "if") {
    const then = asNode(statement.then);
    const otherwise = asNode(statement.else);
    return [
      {
        ...statement,
        then: then === null ? null : branch(then),
        else: otherwise === null || otherwise.kind === "empty" ? otherwise : branch(otherwise),
      },
    ];
  }
  if (statement.kind === "switch") {
    // Groovy's ReturnAdder returns from a case that ends with break, and from the default case.
    const caseBody = (body: AstNode | null, isDefault: boolean): AstNode | null => {
      if (body?.kind !== "block") return body;
      const items = nodeArray(body.statements);
      const last = items.at(-1);
      if (last !== undefined && isSwitchBreak(last)) {
        const kept = items.slice(0, -1);
        const tail = kept.at(-1);
        if (tail === undefined) return body;
        // A case that no longer returns keeps its break.
        const replaced = implicitReturn(tail, context);
        const returns = replaced.at(-1)?.kind === "return";
        return {
          ...body,
          statements: [...kept.slice(0, -1), ...replaced, ...(returns ? [] : [last])],
        };
      }
      return isDefault ? withImplicitReturn(body, context) : body;
    };
    return [
      {
        ...statement,
        cases: nodeArray(statement.cases).map((item) => ({
          ...item,
          body: caseBody(asNode(item.body), false),
        })),
        default: caseBody(asNode(statement.default), true),
      },
    ];
  }
  if (statement.kind !== "expressionStatement") return [statement];
  const expression = asNode(statement.expression);
  if (expression === null) return [statement];
  const assigned =
    expression.kind === "declaration" ||
    (expression.kind === "binary" && expression.operator === "=") ||
    expression.kind === "prefix"
      ? variableName(expression.kind === "prefix" ? expression.value : expression.left)
      : null;
  if (assigned !== null) {
    return [statement, { kind: "return", span, value: { kind: "variable", span, name: assigned } }];
  }
  const call = expression.kind === "methodCall" ? callParts(expression) : null;
  const valueNote =
    expression.kind === "postfix" ||
    expression.kind === "prefix" ||
    (expression.kind === "binary" && !returnsValue(expression, context)) ||
    (call !== null && !call.inherited && (call.name === "each" || call.name === "forEach"));
  if (valueNote) {
    return [
      {
        kind: "importerNote",
        span,
        code: "SX_IMPLICIT_RETURN_VALUE",
        message:
          "Groovy returned the value of this last statement to callers that use the result; the converted function returns nothing here. Add an explicit return if the value matters.",
      },
      statement,
    ];
  }
  if (!returnsValue(expression, context)) return [statement];
  return [{ kind: "return", span, value: expression }];
}

function returnsValue(expression: AstNode, context: LowerContext): boolean {
  if (["declaration", "postfix", "prefix", "closure"].includes(expression.kind)) return false;
  if (expression.kind === "binary" && typeof expression.operator === "string") {
    const operator = expression.operator;
    const assignment = operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(operator);
    return !assignment && operator !== "<<";
  }
  if (expression.kind !== "methodCall") return true;
  const call = callParts(expression);
  if (call === null) return true;
  // A package function shadows the API name it shares.
  const api = legacyApiCall(expression, context);
  if (api !== null && VOID_API_CALLS.has(api.name)) return false;
  // Compact showButton has no result; only the timeout form returns the elapsed time.
  if (api !== null && api.name === "showButton" && api.arguments.length < 2) return false;
  if (!call.inherited && call.name === "exit" && variableName(expression.object) === "System") {
    return false;
  }
  return call.inherited || !EFFECT_COLLECTION_CALLS.has(call.name);
}

/**
 * Names of functions whose result some caller uses: a call in a value position, a reference that keeps the function
 * as a value, or the last statement of a function whose own result is used. Calls are matched by name whatever their
 * receiver, which can only add returns.
 */
export function packageResultUses(files: readonly ParsedGroovyFile[]): Set<string> {
  const used = new Set<string>();
  const tails: Array<{ caller: string; callee: string }> = [];
  const tailOwners = new Map<AstNode, string>();
  const collectTails = (statement: AstNode | null, owner: string): void => {
    if (statement === null) return;
    if (statement.kind === "block")
      collectTails(nodeArray(statement.statements).at(-1) ?? null, owner);
    else if (statement.kind === "if") {
      collectTails(asNode(statement.then), owner);
      collectTails(asNode(statement.else), owner);
    } else if (statement.kind === "switch") {
      for (const item of nodeArray(statement.cases)) {
        const items = nodeArray(asNode(item.body)?.statements);
        const lastItem = items.at(-1);
        collectTails(
          lastItem !== undefined && isSwitchBreak(lastItem) ? (items.at(-2) ?? null) : null,
          owner,
        );
      }
      collectTails(asNode(statement.default), owner);
    } else if (statement.kind === "expressionStatement") tailOwners.set(statement, owner);
  };
  const named = (name: string | null, closure: AstNode | null): void => {
    if (name !== null && closure?.kind === "closure") collectTails(asNode(closure.body), name);
  };
  for (const file of files) {
    walkAst(file.root, (node) => {
      if (node.kind === "declaration") named(variableName(node.left), asNode(node.right));
      if (node.kind === "binary" && node.operator === "=") {
        const left = asNode(node.left);
        named(
          left?.kind === "property" ? constantString(left.property) : variableName(left),
          asNode(node.right),
        );
      }
      if (node.kind === "field" && typeof node.name === "string") {
        named(node.name, asNode(node.initialExpression));
      }
      if (
        typeof node.name === "string" &&
        node.returnType !== undefined &&
        node.returnType !== "void"
      ) {
        collectTails(asNode(node.body), node.name);
      }
    });
  }
  const visit = (node: AstNode, parent: AstNode | null): void => {
    if (node.kind === "methodCall") {
      const call = callParts(node);
      if (call !== null) {
        const owner = parent?.kind === "expressionStatement" ? tailOwners.get(parent) : undefined;
        if (parent?.kind !== "expressionStatement") used.add(call.name);
        else if (owner !== undefined) tails.push({ caller: owner, callee: call.name });
      }
    } else if (node.kind === "variable" || node.kind === "methodPointer") {
      const name = variableName(node) ?? constantString(node.method);
      if (name !== null) used.add(name);
    }
    // Declaring or assigning a name does not use a function's result.
    const assignsName =
      (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) &&
      asNode(node.left)?.kind === "variable";
    for (const [key, value] of Object.entries(node)) {
      if (key === "span" || (node.kind === "methodCall" && key === "method")) continue;
      if (key === "left" && assignsName) continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, node);
      }
    }
  };
  // The last statement of an unnamed closure is its value, which collect(), a list of callbacks, or a callee may use.
  const namedClosures = new Set<AstNode>();
  for (const file of files) {
    walkAst(file.root, (node) => {
      const value =
        node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")
          ? asNode(node.right)
          : node.kind === "field"
            ? asNode(node.initialExpression)
            : null;
      if (value?.kind === "closure") namedClosures.add(value);
    });
  }
  for (const file of files) {
    walkAst(file.root, (node) => {
      if (node.kind !== "closure" || namedClosures.has(node)) return;
      const last = nodeArray(asNode(node.body)?.statements).at(-1);
      const expression = last?.kind === "expressionStatement" ? asNode(last.expression) : null;
      const call = expression === null ? null : callParts(expression);
      if (call !== null) used.add(call.name);
    });
  }
  for (const file of files) if (file.root !== null) visit(file.root, null);
  for (let changed = true; changed;) {
    changed = false;
    for (const { caller, callee } of tails) {
      if (used.has(caller) && !used.has(callee)) {
        used.add(callee);
        changed = true;
      }
    }
  }
  return used;
}

/**
 * Local names visible at `target` inside a function body: parameters, declarations earlier in enclosing blocks,
 * loop variables, and parameters of enclosing closures. Null when `target` is not inside the body.
 */
function visibleLocals(
  body: AstNode,
  parameters: readonly string[],
  target: AstNode,
): Set<string> | null {
  const search = (node: AstNode, visible: ReadonlySet<string>): Set<string> | null => {
    if (node === target) return new Set(visible);
    let inner = visible;
    if (node.kind === "for" && typeof node.variable === "string") {
      // A C-style loop declares its counter in the first control expression.
      const initial = nodeArray(asNode(node.collection)?.items)[0];
      const counter = initial?.kind === "declaration" ? variableName(initial.left) : null;
      inner = new Set([...visible, node.variable, ...(counter === null ? [] : [counter])]);
    }
    if (node.kind === "closure") {
      const names = (groovyParameters(node.parameters) ?? []).map((parameter) => parameter.name);
      inner = new Set([...visible, ...(node.parameterSpecified === true ? names : ["it"])]);
    }
    if (node.kind === "block") {
      const scope = new Set(inner);
      for (const statement of nodeArray(node.statements)) {
        const found = search(statement, scope);
        if (found !== null) return found;
        const expression =
          statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
        const declared = expression?.kind === "declaration" ? variableName(expression.left) : null;
        if (declared !== null) scope.add(declared);
      }
      return null;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!isAstNode(child)) continue;
        const found = search(child, inner);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return search(body, new Set(parameters));
}

function defaultBeforeRequired(
  parameters: ReadonlyArray<{ defaultValue: AstNode | null }>,
): boolean {
  const firstDefault = parameters.findIndex((parameter) => parameter.defaultValue !== null);
  return (
    firstDefault >= 0 &&
    parameters.slice(firstDefault).some((parameter) => parameter.defaultValue === null)
  );
}

/** Parameter and declared local names of a function body, including nested blocks. */
function functionLocalNames(body: AstNode, parameters: readonly string[]): Set<string> {
  const names = new Set(parameters);
  walkAst(body, (node) => {
    if (node.kind === "declaration") {
      const name = variableName(node.left);
      if (name !== null) names.add(name);
    }
    if (node.kind === "for" && typeof node.variable === "string") names.add(node.variable);
    if (node.kind === "closure") {
      for (const parameter of groovyParameters(node.parameters) ?? []) names.add(parameter.name);
    }
  });
  return names;
}

/**
 * A closure used as a value (stored in data, passed as an argument, kept in a local) becomes a string action ID.
 * A closure that only forwards to a function (`{ f() }`, `{ a -> f(a) }`) uses that function's name; any other
 * closure body becomes a generated function. Calls of such values go through the package dispatcher. Closures
 * capturing local variables of their enclosing function are not converted.
 */
function lowerClosureValue(
  closure: AstNode,
  context: LowerContext,
  hint?: string,
): IrExpression | null {
  const body = asNode(closure.body);
  const parameters = groovyParameters(closure.parameters);
  if (body?.kind !== "block" || parameters === null) return null;
  const parameterNames =
    closure.parameterSpecified === true ? parameters.map((p) => p.name) : ["it"];
  const enclosing = context.currentFunction;
  const locals =
    (enclosing?.body === undefined
      ? null
      : visibleLocals(enclosing.body, enclosing.parameters ?? [], closure)) ??
    enclosing?.locals ??
    new Set<string>();
  const ownNames = functionLocalNames(body, parameterNames);
  const captured = new Set<string>();
  // Parameter defaults are evaluated in the closure too, so they capture as much as its body.
  const defaults = parameters.flatMap((parameter) =>
    parameter.defaultValue === null ? [] : [parameter.defaultValue],
  );
  walkAst([body, ...defaults], (node) => {
    // Calling a local closure by name captures it as much as reading it.
    const call = node.kind === "methodCall" ? callParts(node) : null;
    const name = variableName(node) ?? (call?.inherited === true ? call.name : null);
    if (name !== null && locals.has(name) && !ownNames.has(name)) captured.add(name);
  });
  if (captured.size > 0) {
    return unsupportedExpression(
      context,
      closure,
      "SX_CAPTURING_CLOSURE",
      `This closure value captures local ${[...captured].join(", ")} of its enclosing function; TeaseScript has no closures, so pass that state explicitly.`,
    );
  }
  if (defaultBeforeRequired(parameters)) {
    return unsupportedExpression(
      context,
      closure,
      "SX_PARAMETER_DEFAULT_ORDER",
      "This closure gives a parameter a default before a parameter without one; Groovy then fills the required parameters first, which TeaseScript parameters cannot express. Reorder the parameters.",
    );
  }
  // Forwarding keeps the target's own defaults, so the wrapper must not declare any.
  const hasDefaults = parameters.some((parameter) => parameter.defaultValue !== null);
  const forwarded = hasDefaults ? null : forwardedFunction(body, parameterNames, context);
  if (forwarded !== null) {
    context.actions.add(forwarded);
    return { kind: "literal", value: forwarded, action: true };
  }
  const base = hint ?? context.currentFunction?.name ?? "script";
  const name = `${base}Callback${context.closureFunctions.length + 1}`;
  const outerFunction = context.currentFunction;
  context.currentFunction = { name, locals: ownNames, body, parameters: parameterNames };
  context.functionDepth += 1;
  try {
    const implicit = closure.parameterSpecified !== true;
    const functionParameters: IrFunctionParameter[] = [];
    for (const parameter of implicit ? [] : parameters) {
      const defaultValue =
        parameter.defaultValue === null ? null : lowerExpression(parameter.defaultValue, context);
      if (parameter.defaultValue !== null && defaultValue === null) return null;
      functionParameters.push({ name: parameter.name, defaultValue });
    }
    if (implicit)
      functionParameters.push({ name: "it", defaultValue: { kind: "literal", value: null } });
    context.closureFunctions.push({
      kind: "function",
      name,
      parameters: functionParameters,
      // Callers reach a closure value through the dispatcher, whose result may be used.
      body: lowerBlock(withImplicitReturn(body, context), context),
      span: closure.span,
    });
  } finally {
    context.functionDepth -= 1;
    context.currentFunction = outerFunction;
  }
  context.actions.add(name);
  return { kind: "literal", value: name, action: true };
}

/** The function a closure body only forwards to, passing its own parameters unchanged. */
function forwardedFunction(
  body: AstNode,
  parameters: string[],
  context: LowerContext,
): string | null {
  const statements = nodeArray(body.statements);
  const only = statements.length === 1 ? statements[0] : undefined;
  const expression = asNode(only?.kind === "return" ? only.value : only?.expression);
  const call = expression === null ? null : callParts(expression);
  if (call === null || !call.inherited) return null;
  const isFunction = context.functions.has(call.name) || context.packageFunctions.has(call.name);
  if (!isFunction) return null;
  const names = call.arguments.map((argument) => variableName(argument));
  const expected = parameters[0] === "it" && names.length === 0 ? [] : parameters;
  return names.length === expected.length && names.every((name, index) => name === expected[index])
    ? call.name
    : null;
}

function lowerAssignment(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const operator = text(node.operator);
  if (operator === "<<") {
    // Groovy `list << value` appends one element.
    const listNode = asNode(node.left);
    const valueNode = asNode(node.right);
    if (listNode !== null && valueNode !== null && isKnownListExpression(listNode, context)) {
      const target = lowerExpression(listNode, context);
      const value = lowerExpression(valueNode, context);
      if (target === null || value === null) return [];
      noteSharedListWrite(listNode, node, context);
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target, name: "add", arguments: [value] },
          span,
        },
      ];
    }
  }
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  const voidCall = leftNode === null ? null : legacyApiCall(leftNode, context);
  if (
    operator === "+" &&
    leftNode !== null &&
    rightNode !== null &&
    voidCall !== null &&
    VOID_API_CALLS.has(voidCall.name) &&
    isPure(rightNode, context) &&
    onlyOf(inferType(rightNode, context.types), STRING)
  ) {
    // `show(a) + (b)`: Groovy appended b to the call's null result and discarded it, so b was never shown.
    addDiagnostic(
      context,
      "SX_DISCARDED_CONCATENATION",
      "warning",
      `Groovy appended text to the result of ${voidCall.name}(), which returns nothing, and discarded it; the appended text was never shown and is dropped here.`,
      span,
    );
    return lowerStatement({ kind: "expressionStatement", span, expression: leftNode }, context);
  }
  if (
    operator !== "=" &&
    operator !== "+=" &&
    operator !== "-=" &&
    operator !== "*=" &&
    operator !== "/="
  ) {
    const lowered = lowerExpression(node, context);
    return lowered === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_BINARY_STATEMENT",
            `Unsupported binary statement operator ${operator ?? "?"}.`,
          ),
        ]
      : [{ kind: "expression", expression: lowered, span }];
  }
  const targetNode = asNode(node.left);
  const right = asNode(node.right);
  if (targetNode === null || right === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
        "Assignment target or value is missing.",
      ),
    ];
  }
  const variableTarget = variableName(targetNode);
  if (operator === "=" && variableTarget !== null) {
    const collectionLoop = lowerCollectionAssignment(false, variableTarget, right, span, context);
    if (collectionLoop !== null) return collectionLoop;
  }
  if (operator !== "=" && variableTarget === null && isRepeatableIndex(targetNode)) {
    // `items[i] += v` evaluates `items` and `i` twice harmlessly when both are plain references.
    const binaryOperator = operator.slice(0, -1);
    const expanded: AstNode = {
      kind: "binary",
      span: node.span,
      operator: binaryOperator,
      left: targetNode,
      right,
    };
    return lowerAssignment({ ...node, operator: "=", right: expanded }, span, context);
  }
  let target: IrExpression | null = null;
  if (variableTarget !== null) target = { kind: "variable", name: variableTarget };
  else if (operator === "=" && targetNode.kind === "binary" && targetNode.operator === "[") {
    const listNode = asNode(targetNode.left);
    const indexNode = asNode(targetNode.right);
    const fromEnd = indexNode === null ? null : negativeConstantIndex(indexNode);
    if (fromEnd !== null) {
      // `list[-1] = v` writes the last element; `.last` is not assignable, so the index counts from the length.
      const list =
        listNode !== null &&
        isRepeatableExpression(listNode) &&
        isKnownListExpression(listNode, context)
          ? lowerExpression(listNode, context)
          : null;
      target =
        list === null
          ? unsupportedExpression(
              context,
              targetNode,
              "SX_NEGATIVE_INDEX",
              "Groovy counted this negative index from the end; the receiver is not proven to be a list or cannot be evaluated twice. Index from the end explicitly.",
            )
          : {
              kind: "index",
              target: list,
              index: {
                kind: "binary",
                operator: "-",
                left: { kind: "property", target: list, name: "length" },
                right: { kind: "literal", value: fromEnd },
              },
            };
    } else {
      target = lowerExpression(targetNode, context);
    }
    if (target !== null) noteSharedListWrite(asNode(targetNode.left), node, context);
  } else if (operator === "=" && targetNode.kind === "property") {
    target = lowerExpression(targetNode, context);
    if (target !== null) {
      addDiagnostic(
        context,
        "SX_SHARED_MAP_WRITE",
        "warning",
        "Groovy maps are shared by reference; if this map came from a list, a parameter, or another variable, the TeaseScript write changes only this copy (ADR 0014).",
        node.span,
      );
    }
  }
  if (target === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
        "Only local variables and indexed list targets are migrated automatically.",
      ),
    ];
  }
  const value = lowerExpression(right, context);
  if (value === null) {
    const targetName = variableTarget ?? "indexed target";
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_ASSIGNMENT_VALUE",
        `Cannot safely migrate assignment to ${targetName}.`,
      ),
    ];
  }
  if (operator === "*=" || operator === "/=") {
    if (variableTarget === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
          "Compound assignment to an indexed target requires single-evaluation rewriting.",
        ),
      ];
    }
    return [
      {
        kind: "assign",
        target,
        operator: "=",
        value: {
          kind: "binary",
          operator: operator === "*=" ? "*" : "/",
          left: { kind: "variable", name: variableTarget },
          right: value,
        },
        span,
      },
    ];
  }
  if (operator === "+=" && variableTarget !== null) {
    // TeaseScript += only adds numbers; text and list appends become an ordinary assignment.
    const sum = lowerPlus(
      { kind: "binary", span: node.span, operator: "+", left: targetNode, right },
      context,
    );
    if (sum === null) return [];
    if (sum.kind !== "binary") return [{ kind: "assign", target, operator: "=", value: sum, span }];
  }
  return [{ kind: "assign", target, operator, value, span }];
}

function lowerPostfix(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const operator = text(node.operator);
  const target = variableName(node.value);
  if ((operator !== "++" && operator !== "--") || target === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_POSTFIX",
        "Only local-variable ++/-- statements are supported.",
      ),
    ];
  }
  return [
    {
      kind: "assign",
      target: { kind: "variable", name: target },
      operator: operator === "++" ? "+=" : "-=",
      value: { kind: "literal", value: 1 },
      span,
    },
  ];
}

function lowerCallStatement(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const call = callParts(node);
  if (call !== null && !call.inherited && (call.name === "each" || call.name === "forEach")) {
    return lowerEachStatement(node, call.arguments, span, context);
  }
  const collectionStatement =
    call === null || call.inherited ? null : lowerCollectionStatement(node, call, span, context);
  if (collectionStatement !== null) return collectionStatement;
  const receiverName = variableName(node.object);
  if (
    call !== null &&
    receiverName !== null &&
    context.classLoaderVariables.has(receiverName) &&
    call.name === "addClasspath"
  ) {
    addDiagnostic(
      context,
      "SX_LEGACY_HELPER_SETUP",
      "info",
      "Removed GroovyClassLoader classpath setup; helper source is migrated separately.",
      span,
    );
    return [];
  }
  if (
    call !== null &&
    !call.inherited &&
    receiverName === "System" &&
    call.name === "exit" &&
    call.arguments.length <= 1 &&
    call.arguments.every((argument) => isPure(argument, context))
  ) {
    addDiagnostic(
      context,
      "SX_SYSTEM_EXIT",
      "warning",
      "System.exit() closed the legacy application; TeaseScript exit ends the session but leaves the Player open.",
      span,
    );
    return [{ kind: "exit", span }];
  }
  if (call !== null && !call.inherited && (call.name === "push" || call.name === "leftShift")) {
    // Groovy 2.5 List.push appends like add().
    const receiver = asNode(node.object);
    if (
      receiver !== null &&
      isKnownListExpression(receiver, context) &&
      call.arguments.length === 1
    ) {
      const target = lowerExpression(receiver, context);
      const value = lowerExpression(call.arguments[0]!, context);
      if (target === null || value === null) return [];
      noteSharedListWrite(receiver, node, context);
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target, name: "add", arguments: [value] },
          span,
        },
      ];
    }
  }
  if (call === null || !call.inherited) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_CALL",
            "Method call is not a supported SexScript call.",
          ),
        ]
      : [{ kind: "expression", expression, span }];
  }
  if (call.name === "sleep") {
    // Groovy's sleep(milliseconds) blocks the script thread like a hidden wait.
    return oneArgumentStatement(call.arguments, context, node, (duration) => ({
      kind: "wait",
      duration,
      visible: false,
      unit: "ms",
      span,
    }));
  }
  if (
    context.functions.has(call.name) ||
    context.packageFunctions.has(call.name) ||
    context.helperFunctions.has(call.name)
  ) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_HELPER_CALL",
            `Helper call ${call.name}() could not be migrated.`,
          ),
        ]
      : [{ kind: "expression", expression, span }];
  }
  if (
    context.helperMainParameter !== null &&
    variableName(node.object) !== context.helperMainParameter
  ) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_HELPER_CALL",
            `Unqualified helper call ${call.name}() could not be migrated.`,
          ),
        ]
      : [{ kind: "expression", expression, span }];
  }

  const args = call.arguments;
  if (INPUT_CALLS.has(call.name)) {
    // An input whose result the legacy statement ignored: TeaseScript allows only calls as expression
    // statements, so the answer goes into a variable (a yes/no answer without its comparison).
    const expression = lowerExpression(node, context);
    if (expression === null) return [];
    if (expression.kind === "call") return [{ kind: "expression", expression, span }];
    const answer =
      expression.kind === "binary" && expression.left.kind === "choice"
        ? expression.left
        : expression;
    context.ignoredInputs += 1;
    return [{ kind: "let", name: `ignoredAnswer${context.ignoredInputs}`, value: answer, span }];
  }
  switch (call.name) {
    case "setInfos":
      extractMetadata(args, context, node.span);
      return [];
    case "show":
      if (args.length === 0 || isNullConstant(args[0])) {
        // show(null) cleared the legacy text area; a TeaseScript transcript keeps its history.
        addDiagnostic(
          context,
          "SX_SHOW_CLEAR",
          "info",
          "Dropped show(null), which only cleared the legacy text area.",
          span,
        );
        return [];
      }
      noteUnintendedMarkup(args[0], context);
      return oneArgumentStatement(args, context, node, (value) => ({ kind: "say", value, span }));
    case "wait":
      return oneArgumentStatement(args, context, node, (duration) => ({
        kind: "wait",
        duration,
        visible: false,
        unit: "s",
        span,
      }));
    case "waitWithGauge":
      return oneArgumentStatement(args, context, node, (duration) => ({
        kind: "wait",
        duration,
        visible: true,
        unit: "s",
        span,
      }));
    case "showButton": {
      if (args.length < 1 || args.length > 2) {
        return [
          unsupportedStatement(
            context,
            node,
            "SX_BUTTON_ARITY",
            "showButton() must have one or two arguments.",
          ),
        ];
      }
      const label = lowerExpression(args[0]!, context);
      const timeout = args[1] === undefined ? null : lowerExpression(args[1], context);
      if (label === null || (args[1] !== undefined && timeout === null)) {
        return [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_BUTTON_ARGUMENT",
            "showButton() arguments could not be migrated.",
          ),
        ];
      }
      return [{ kind: "showButton", label, timeout, span }];
    }
    case "showPopup":
      return oneArgumentStatement(args, context, node, (message) => ({
        kind: "showPopup",
        message,
        span,
      }));
    case "setImage":
      if (args.length !== 1)
        return [
          unsupportedStatement(
            context,
            node,
            "SX_SET_IMAGE_ARITY",
            "setImage byte-array overload is not automatically migrated.",
          ),
        ];
      if (isNullConstant(args[0])) return [{ kind: "hideImage", span }];
      return oneArgumentStatement(args, context, node, (file) => ({
        kind: "showImage",
        file,
        span,
      }));
    case "playSound":
      return oneArgumentStatement(args, context, node, (file) => ({
        kind: "playAudio",
        file,
        async: false,
        repeatCount: null,
        span,
      }));
    case "playBackgroundSound":
      return lowerBackgroundSound(args, node, span, context);
    case "stopSoundThreads":
      if (args.length !== 0)
        return [
          unsupportedStatement(
            context,
            node,
            "SX_STOP_SOUND_ARITY",
            "stopSoundThreads() must have no arguments.",
          ),
        ];
      return [
        { kind: "expression", expression: useHelper(context, "stopBackgroundSounds", []), span },
      ];
    case "save":
      return lowerSave(args, node, span, context);
    case "exit":
      if (args.length !== 0)
        return [
          unsupportedStatement(context, node, "SX_EXIT_ARITY", "exit() must have no arguments."),
        ];
      return [{ kind: "exit", span }];
    default: {
      const expression = lowerExpression(node, context);
      return expression === null
        ? [
            unsupportedStatement(
              context,
              node,
              "SX_UNSUPPORTED_CALL",
              `Unsupported SexScript call: ${call.name}`,
            ),
          ]
        : [{ kind: "expression", expression, span }];
    }
  }
}

/**
 * `target = list.collect { x -> f(x) }` and its relatives become an initial value plus an ordinary loop:
 * collect/findAll build a list, find picks the first match, any/every compute a flag, and sum adds up.
 */
function lowerCollectionAssignment(
  declaration: boolean,
  target: string,
  right: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | null {
  const call = callParts(right);
  const receiver = asNode(right.object);
  if (call === null || call.inherited || receiver === null) return null;
  if (!["collect", "findAll", "find", "any", "every", "sum"].includes(call.name)) return null;
  if (receiver.kind !== "range" && !isKnownListExpression(receiver, context)) return null;
  // The loop reads the receiver after the target is initialized, so the receiver must not mention it.
  if (closureUsesName({ kind: "closure", span: null, body: receiver }, target)) return null;
  const argument =
    call.arguments.length === 0 && call.name === "sum" ? null : closureArgument(call.arguments);
  if (argument === null && !(call.name === "sum" && call.arguments.length === 0)) return null;
  if (argument !== null && argument.parameters.length !== 1) return null;
  const variable = argument?.parameters[0] ?? "item";
  const result = argument === null ? null : closureResult(argument.closure);
  if (argument !== null && result === null) return null;
  // Groovy sum() adds numbers (it joins text) and returns null for an empty list.
  const summand =
    result === null ? listElementType(receiver, context) : inferType(result.value, context.types);
  const nonEmpty =
    (receiver.kind === "list" && nodeArray(receiver.items).length > 0) ||
    (receiver.kind === "range" &&
      constantValue(asNode(receiver.from) ?? undefined) !== undefined &&
      constantValue(asNode(receiver.to) ?? undefined) !== undefined);
  if (
    call.name === "sum" &&
    (!onlyOf(summand, NUMBER) ||
      (!nonEmpty && !isRepeatableExpression(receiver)) ||
      (argument !== null &&
        variableName(receiver) !== null &&
        closureUsesName(argument.closure, variableName(receiver)!)))
  ) {
    return null;
  }

  // From here on the idiom is recognized; an inner failure keeps its own root diagnostic.
  const failed = (): IrStatement[] => [
    unsupportedStatement(
      context,
      right,
      "SX_UNSUPPORTED_DECLARATION_VALUE",
      `Cannot safely migrate the ${call.name}() loop for ${target}.`,
    ),
  ];
  const collection = lowerExpression(receiver, context);
  if (collection === null) return failed();
  // A loop body that reads the target sees its old value only through a separate result variable.
  const readsTarget = argument !== null && closureUsesName(argument.closure, target);
  const accumulator = readsTarget ? freshName(`${call.name}Result`, context) : target;
  const targetVariable: IrExpression = { kind: "variable", name: accumulator };
  const item: IrExpression = { kind: "variable", name: variable };
  const prefix = result === null ? [] : lowerStatementList(result.statements, null, context);
  const assign = (value: IrExpression): IrStatement => ({
    kind: "assign",
    target: targetVariable,
    operator: "=",
    value,
    span,
  });
  const add = (value: IrExpression): IrStatement => ({
    kind: "expression",
    expression: { kind: "methodCall", target: targetVariable, name: "add", arguments: [value] },
    span,
  });
  const condition = (): IrExpression | null =>
    result === null ? null : lowerCondition(result.value, context);
  let initial: IrExpression;
  let body: IrStatement[];
  switch (call.name) {
    case "collect": {
      const value = lowerExpression(result!.value, context);
      if (value === null) return failed();
      initial = { kind: "list", items: [] };
      body = [...prefix, add(value)];
      break;
    }
    case "findAll": {
      const test = condition();
      if (test === null) return failed();
      initial = { kind: "list", items: [] };
      body = [...prefix, { kind: "if", condition: test, then: [add(item)], else: [], span }];
      break;
    }
    case "find":
    case "any":
    case "every": {
      const test = condition();
      if (test === null) return failed();
      const found =
        call.name === "find" ? item : { kind: "literal" as const, value: call.name === "any" };
      initial = { kind: "literal", value: call.name === "find" ? null : call.name === "every" };
      body = [
        ...prefix,
        {
          kind: "if",
          condition: call.name === "every" ? negate(test) : test,
          then: [assign(found), { kind: "break", span }],
          else: [],
          span,
        },
      ];
      break;
    }
    default: {
      const value = result === null ? item : lowerExpression(result.value, context);
      if (value === null) return failed();
      initial = { kind: "literal", value: 0 };
      body = [...prefix, { kind: "assign", target: targetVariable, operator: "+=", value, span }];
    }
  }
  const start: IrStatement =
    declaration || readsTarget
      ? { kind: "let", name: accumulator, value: initial, span }
      : assign(initial);
  const loop: IrStatement = { kind: "for", variable, collection, body, span };
  const empty: IrStatement[] =
    call.name === "sum" && !nonEmpty
      ? [
          {
            kind: "if",
            condition: {
              kind: "binary",
              operator: "==",
              left: { kind: "property", target: collection, name: "length" },
              right: { kind: "literal", value: 0 },
            },
            then: [assign({ kind: "literal", value: null })],
            else: [],
            span,
          },
        ]
      : [];
  if (!readsTarget) return [start, loop, ...empty];
  const accumulated: IrExpression = { kind: "variable", name: accumulator };
  const store: IrStatement = declaration
    ? { kind: "let", name: target, value: accumulated, span }
    : {
        kind: "assign",
        target: { kind: "variable", name: target },
        operator: "=",
        value: accumulated,
        span,
      };
  return [start, loop, ...empty, store];
}

/** A generated variable name that no variable of the file and no earlier generated name uses. */
function freshName(base: string, context: LowerContext): string {
  let candidate = base;
  for (
    let suffix = 2;
    context.types.variables.has(candidate) || context.generatedNames.has(candidate);
    suffix += 1
  ) {
    candidate = `${base}${suffix}`;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

/** Element type of a range, list literal, or list variable with known elements. */
function listElementType(node: AstNode, context: LowerContext): number {
  if (node.kind === "range") return NUMBER;
  if (node.kind === "list") {
    return nodeArray(node.items).reduce((type, item) => type | inferType(item, context.types), 0);
  }
  return context.types.listElements?.get(variableName(node) ?? "") ?? UNKNOWN;
}

/** A closure body ending in an expression (or `return expression`) with no other returns. */
function closureResult(closure: AstNode): { statements: AstNode[]; value: AstNode } | null {
  const statements = nodeArray(asNode(closure.body)?.statements);
  const last = statements.at(-1);
  const value = asNode(
    last?.kind === "return"
      ? last.value
      : last?.kind === "expressionStatement"
        ? last.expression
        : null,
  );
  if (value === null) return null;
  const leading = statements.slice(0, -1);
  if (leading.some((statement) => containsReturnForCurrentClosure(statement))) return null;
  return { statements: leading, value };
}

/** Single closure argument with its loop variable name (`it` when the closure declares none). */
function closureArgument(args: AstNode[]): { closure: AstNode; parameters: string[] } | null {
  const closure = args.length === 1 && args[0]!.kind === "closure" ? args[0]! : null;
  if (closure === null || asNode(closure.body)?.kind !== "block") return null;
  const parameters = groovyParameters(closure.parameters);
  if (parameters === null) return null;
  return {
    closure,
    parameters: closure.parameterSpecified === true ? parameters.map((p) => p.name) : ["it"],
  };
}

/**
 * Statement-level Groovy collection idioms that become ordinary loops or helper assignments:
 * `n.times { }`, `list.eachWithIndex { item, i -> }`, `Collections.shuffle(list)`, `list.unique()`, and
 * `list.remove(i)` with a numeric position.
 */
function lowerCollectionStatement(
  node: AstNode,
  call: { name: string; arguments: AstNode[] },
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | null {
  const receiver = asNode(node.object);
  if (receiver === null) return null;
  const body = (closure: AstNode): AstNode => asNode(closure.body)!;
  if (call.name === "times" && onlyOf(inferType(receiver, context.types), NUMBER)) {
    const argument = closureArgument(call.arguments);
    if (
      argument === null ||
      argument.parameters.length > 1 ||
      containsReturnForCurrentClosure(body(argument.closure))
    ) {
      return null;
    }
    const lowered = lowerExpression(receiver, context);
    if (lowered === null) return null;
    // Groovy runs n.times for the integer part of n and not at all below one; `repeat` needs a whole count, so
    // other counts loop over a range, which is empty for a count of zero or less.
    const count =
      lowered.kind === "literal" && typeof lowered.value === "number"
        ? { ...lowered, value: Math.max(0, Math.trunc(lowered.value)) }
        : lowered;
    const wholeCount =
      count.kind === "literal" || (count.kind === "property" && count.name === "length");
    const loopBody = lowerBlock(body(argument.closure), context);
    const variable = argument.parameters[0]!;
    const usesIndex = closureUsesName(argument.closure, variable) || !wholeCount;
    return usesIndex
      ? [
          {
            kind: "for",
            variable,
            collection: {
              kind: "range",
              from: { kind: "literal", value: 0 },
              to: count,
              inclusive: false,
            },
            body: loopBody,
            span,
          },
        ]
      : [{ kind: "repeat", count, body: loopBody, span }];
  }
  if (
    call.name === "eachWithIndex" &&
    isKnownListExpression(receiver, context) &&
    isRepeatableExpression(receiver)
  ) {
    const argument = closureArgument(call.arguments);
    if (
      argument === null ||
      argument.parameters.length !== 2 ||
      containsReturnForCurrentClosure(body(argument.closure))
    ) {
      return null;
    }
    const list = lowerExpression(receiver, context);
    if (list === null) return null;
    const item = argument.parameters[0]!;
    const index = argument.parameters[1]!;
    return [
      {
        kind: "for",
        variable: index,
        collection: {
          kind: "range",
          from: { kind: "literal", value: 0 },
          to: { kind: "property", target: list, name: "length" },
          inclusive: false,
        },
        body: [
          {
            kind: "let",
            name: item,
            value: { kind: "index", target: list, index: { kind: "variable", name: index } },
            span,
          },
          ...lowerBlock(body(argument.closure), context),
        ],
        span,
      },
    ];
  }
  const shuffledList =
    variableName(receiver) === "Collections" && call.name === "shuffle"
      ? call.arguments[0]
      : undefined;
  const listTarget = shuffledList ?? receiver;
  const listName = variableName(listTarget);
  if (listName === null || !isKnownListExpression(listTarget, context)) return null;
  const list: IrExpression = { kind: "variable", name: listName };
  const reassign = (value: IrExpression): IrStatement[] => [
    { kind: "assign", target: list, operator: "=", value, span },
  ];
  if (shuffledList !== undefined && call.arguments.length === 1) {
    return reassign(useHelper(context, "shuffled", [list]));
  }
  if (call.name === "unique" && call.arguments.length === 0)
    return reassign(useHelper(context, "unique", [list]));
  if (call.name === "remove" && call.arguments.length === 1) {
    const argument = call.arguments[0]!;
    const value = lowerExpression(argument, context);
    if (value === null) return null;
    if (onlyOf(inferType(argument, context.types), NUMBER))
      return reassign(useHelper(context, "removeAt", [list, value]));
    if (onlyOf(inferType(argument, context.types), STRING | BOOLEAN)) {
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target: list, name: "remove", arguments: [value] },
          span,
        },
      ];
    }
  }
  if (call.name === "clear" && call.arguments.length === 0) {
    return [
      {
        kind: "expression",
        expression: { kind: "methodCall", target: list, name: "clear", arguments: [] },
        span,
      },
    ];
  }
  return null;
}

/** Whether a closure reads its implicit parameter, outside nested closures that have their own. */
function readsOwnIt(closure: AstNode): boolean {
  let reads = false;
  const visit = (node: AstNode): void => {
    if (node !== closure && node.kind === "closure") return;
    if (variableName(node) === "it") reads = true;
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (isAstNode(child)) visit(child);
    }
  };
  visit(closure);
  return reads;
}

function closureUsesName(closure: AstNode, name: string): boolean {
  let used = false;
  walkAst(closure.body, (node) => {
    if (variableName(node) === name) used = true;
  });
  return used;
}

function lowerEachStatement(
  node: AstNode,
  args: AstNode[],
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const receiverNode = asNode(node.object);
  if (receiverNode === null || args.length !== 1 || args[0]?.kind !== "closure") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_SHAPE",
        "Groovy each() needs one inline closure for automatic migration.",
      ),
    ];
  }
  if (receiverNode.kind !== "range" && !isKnownListExpression(receiverNode, context)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_RECEIVER",
        "Groovy each() is migrated automatically only for a proven list or numeric range receiver.",
      ),
    ];
  }

  const closure = args[0];
  const body = asNode(closure.body);
  if (body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_BODY",
        "Groovy each() closure does not contain a normal block body.",
      ),
    ];
  }
  const returns = closureReturns(body);
  if (
    returns.some(
      ({ insideLoop, value }) => insideLoop || (value !== null && !isPure(value, context)),
    )
  ) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_RETURN",
        "Groovy return inside each() ends only the current iteration; here it sits in a nested loop or returns a value with side effects, so it needs a manual rewrite.",
      ),
    ];
  }

  const parameterSpecified = closure.parameterSpecified === true;
  const closureParameters = groovyParameters(closure.parameters);
  if (closureParameters === null || (parameterSpecified && closureParameters.length !== 1)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_PARAMETERS",
        "Only one-parameter list/range each() closures are migrated automatically.",
      ),
    ];
  }
  const variable = parameterSpecified ? closureParameters[0]!.name : "it";

  const collection = lowerExpression(receiverNode, context);
  if (collection === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_RECEIVER",
        "Groovy each() receiver could not be migrated safely.",
      ),
    ];
  }
  if (returns.length > 0) {
    addDiagnostic(
      context,
      "SX_EACH_RETURN_CONTINUE",
      "warning",
      "Groovy return inside each() ended only the current iteration and each() discarded its value; it becomes continue. Check whether leaving the enclosing function was intended.",
      returns[0]!.node.span,
    );
  }
  const loopBody = lowerBlock(body, context);
  return [
    {
      kind: "for",
      variable,
      collection,
      body: returns.length > 0 ? withoutFinalContinue(returnsAsContinue(loopBody)) : loopBody,
      span,
    },
  ];
}

/** Return statements of a closure body, outside nested closures, and whether a loop encloses them. */
function closureReturns(
  body: AstNode,
): Array<{ node: AstNode; value: AstNode | null; insideLoop: boolean }> {
  const found: Array<{ node: AstNode; value: AstNode | null; insideLoop: boolean }> = [];
  const visit = (node: AstNode, insideLoop: boolean): void => {
    if (node.kind === "closure") return;
    if (node.kind === "return") found.push({ node, value: asNode(node.value), insideLoop });
    const loop = node.kind === "for" || node.kind === "while";
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, insideLoop || loop);
      }
    }
  };
  visit(body, false);
  return found;
}

/** A continue at the end of a loop body, also at the end of a final if branch, does nothing. */
function withoutFinalContinue(statements: IrStatement[]): IrStatement[] {
  const last = statements.at(-1);
  if (last?.kind === "continue") return statements.slice(0, -1);
  if (last?.kind !== "if") return statements;
  return [
    ...statements.slice(0, -1),
    { ...last, then: withoutFinalContinue(last.then), else: withoutFinalContinue(last.else) },
  ];
}

/** At script level a lowered return is a script transfer or end; inside each() it only ended the iteration. */
function returnsAsContinue(statements: IrStatement[]): IrStatement[] {
  return statements.map((statement): IrStatement => {
    switch (statement.kind) {
      case "return":
      case "run":
      case "end":
        return { kind: "continue", span: statement.span };
      case "if":
        return {
          ...statement,
          then: returnsAsContinue(statement.then),
          else: returnsAsContinue(statement.else),
        };
      case "switch":
        return {
          ...statement,
          cases: statement.cases.map((item) => ({ ...item, body: returnsAsContinue(item.body) })),
          default: returnsAsContinue(statement.default),
        };
      default:
        return statement;
    }
  });
}

function containsReturnForCurrentClosure(node: AstNode, root = true): boolean {
  if (!root && node.kind === "closure") return false;
  if (node.kind === "return") return true;
  for (const value of Object.values(node)) {
    if (isAstNode(value) && containsReturnForCurrentClosure(value, false)) return true;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item) && containsReturnForCurrentClosure(item, false)) return true;
      }
    }
  }
  return false;
}

function lowerBackgroundSound(
  args: AstNode[],
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (args.length === 1 && isNullConstant(args[0])) {
    return [
      { kind: "expression", expression: useHelper(context, "stopBackgroundSounds", []), span },
    ];
  }
  if (args.length < 1 || args.length > 2 || isNullConstant(args[0])) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_BACKGROUND_SOUND_CONTROL",
        "This background sound call needs manual migration.",
      ),
    ];
  }
  const file = lowerExpression(args[0]!, context);
  const repeatCount = args[1] === undefined ? null : lowerExpression(args[1], context);
  if (file === null || (args[1] !== undefined && repeatCount === null)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_BACKGROUND_SOUND_ARGUMENT",
        "Background sound arguments could not be migrated.",
      ),
    ];
  }
  const fixedPasses =
    repeatCount === null ||
    (repeatCount.kind === "literal" &&
      typeof repeatCount.value === "number" &&
      Number.isInteger(repeatCount.value) &&
      repeatCount.value >= 1);
  if (context.stopsBackgroundSounds || !fixedPasses) {
    // Keep the handle so a later playBackgroundSound(null) can stop this sound; the helper also plays nothing for
    // fewer than one pass, which `repeat: n times` rejects.
    const passes = repeatCount ?? { kind: "literal", value: 1 };
    return [
      {
        kind: "expression",
        expression: useHelper(context, "playBackgroundSound", [file, passes]),
        span,
      },
    ];
  }
  return [{ kind: "playAudio", file, async: true, repeatCount, span }];
}

/** Whether any file stops all background sounds with playBackgroundSound(null) or stopSoundThreads(). */
export function packageStopsBackgroundSounds(files: readonly ParsedGroovyFile[]): boolean {
  let stops = false;
  for (const file of files) {
    walkAst(file.root, (node) => {
      const call = node.kind === "methodCall" ? callParts(node) : null;
      if (call === null || !call.inherited) return;
      if (call.name === "stopSoundThreads") stops = true;
      // A file that may be null at runtime stops all sounds as well.
      const file = call.arguments[0];
      if (
        call.name === "playBackgroundSound" &&
        !(file?.kind === "constant" && typeof file.value === "string")
      ) {
        stops = true;
      }
    });
  }
  return stops;
}

function lowerSave(
  args: AstNode[],
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (args.length !== 2)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_SAVE_ARITY",
        "save() must have exactly two arguments.",
      ),
    ];
  const key = lowerExpression(args[0]!, context);
  if (key === null)
    return [
      unsupportedStatement(context, node, "SX_SAVE_ARGUMENT", "save() key could not be migrated."),
    ];
  // Legacy save(key, null) deleted the key. Generated reads compare with null explicitly, so a stored null and a
  // missing key behave alike; only a literal null needs the explicit delete.
  if (isNullConstant(args[1])) return [{ kind: "delete", key, span }];
  const value = lowerExpression(args[1]!, context);
  if (value === null)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_SAVE_ARGUMENT",
        "save() value could not be migrated.",
      ),
    ];
  return [{ kind: "save", key, value, span }];
}

function lowerIf(node: AstNode, context: LowerContext): IrStatement[] {
  const conditionNode = asNode(node.condition);
  const thenNode = asNode(node.then);
  const elseNode = asNode(node.else);
  const condition = conditionNode === null ? null : lowerCondition(conditionNode, context);
  if (condition === null || thenNode === null || thenNode.kind === "empty") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_IF",
        "if condition or body could not be migrated safely.",
      ),
    ];
  }
  return [
    {
      kind: "if",
      condition,
      then: lowerBranch(thenNode, context),
      else: elseNode === null ? [] : lowerBranch(elseNode, context),
      span: node.span,
    },
  ];
}

function lowerBranch(node: AstNode, context: LowerContext): IrStatement[] {
  if (node.kind === "empty") return [];
  if (node.kind === "block") return lowerBlock(node, context);
  const [prelude, lowered, postlude] = withSurroundings(context, node);
  return [...prelude, ...lowered, ...postlude];
}

function lowerWhile(node: AstNode, context: LowerContext): IrStatement[] {
  const conditionNode = asNode(node.condition);
  const body = asNode(node.body);
  const always: IrExpression = { kind: "literal", value: true };
  const effect = conditionNode?.kind === "binary" ? asNode(conditionNode.left) : null;
  if (
    body !== null &&
    effect !== null &&
    conditionNode?.operator === "||" &&
    isTrueConstant(asNode(conditionNode.right))
  ) {
    // `while (effect() || true)` performs the effect before every iteration of an endless loop.
    const statement: AstNode = {
      kind: "expressionStatement",
      span: effect.span,
      expression: effect,
    };
    return [
      {
        kind: "while",
        condition: always,
        body: [...lowerBranch(statement, context), ...lowerBranch(body, context)],
        span: node.span,
      },
    ];
  }
  const [prelude, condition] = withPrelude(context, () =>
    conditionNode === null ? null : lowerCondition(conditionNode, context),
  );
  if (condition !== null && body !== null && prelude.length > 0) {
    // The prompt must be shown before every evaluation of the condition, not once before the loop.
    return [
      {
        kind: "while",
        condition: always,
        body: [...prelude, breakUnless(condition), ...lowerBranch(body, context)],
        span: node.span,
      },
    ];
  }
  if (condition === null || body === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_WHILE",
        "while condition or body could not be migrated safely.",
      ),
    ];
  }
  return [{ kind: "while", condition, body: lowerBranch(body, context), span: node.span }];
}

function breakUnless(condition: IrExpression): IrStatement {
  return {
    kind: "if",
    condition: negate(condition),
    then: [{ kind: "break", span: null }],
    else: [],
    span: null,
  };
}

function negate(condition: IrExpression): IrExpression {
  if (condition.kind === "unary" && condition.operator === "not") return condition.value;
  if (
    condition.kind === "binary" &&
    (condition.operator === "and" || condition.operator === "or")
  ) {
    // De Morgan keeps generated null/zero/empty checks readable: `x == null or x == 0`.
    return {
      kind: "binary",
      operator: condition.operator === "and" ? "or" : "and",
      left: negate(condition.left),
      right: negate(condition.right),
    };
  }
  if (condition.kind === "binary" && condition.operator === "==") {
    return { ...condition, operator: "!=" };
  }
  if (condition.kind === "binary" && condition.operator === "!=") {
    return { ...condition, operator: "==" };
  }
  return { kind: "unary", operator: "not", value: condition };
}

function lowerFor(node: AstNode, context: LowerContext): IrStatement[] {
  const variable = text(node.variable);
  const collectionNode = asNode(node.collection);
  const body = asNode(node.body);
  if (variable === "forLoopDummyParameter" && collectionNode?.kind === "list") {
    return lowerCStyleFor(node, collectionNode, body, context);
  }
  const collection = collectionNode === null ? null : lowerExpression(collectionNode, context);
  if (variable === null || collection === null || body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_FOR",
        "for loop could not be migrated safely.",
      ),
    ];
  }
  return [{ kind: "for", variable, collection, body: lowerBlock(body, context), span: node.span }];
}

function lowerCStyleFor(
  node: AstNode,
  collection: AstNode,
  body: AstNode | null,
  context: LowerContext,
): IrStatement[] {
  const parts = nodeArray(collection.items);
  if (parts.length !== 3 || body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_FOR",
        "C-style for loop shape is not supported.",
      ),
    ];
  }
  const initial = parts[0]!;
  const conditionNode = parts[1]!;
  const update = parts[2]!;
  // Each control expression is its own evaluation point, so input prompts stay next to it.
  const [initialPrelude, initialStatements] = withStatementRoot(context, initial, () =>
    lowerForControlExpression(initial, context),
  );
  const [prelude, condition] = withStatementRoot(context, conditionNode, () =>
    lowerCondition(conditionNode, context),
  );
  const [updatePrelude, updateStatements] = withStatementRoot(context, update, () =>
    lowerForControlExpression(update, context),
  );
  if (
    condition === null ||
    prelude.length > 0 ||
    initialStatements === null ||
    updateStatements === null
  ) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_FOR",
        "C-style for loop control expressions could not be migrated safely.",
      ),
    ];
  }

  const step = [...updatePrelude, ...updateStatements];
  return [
    ...initialPrelude,
    ...initialStatements,
    {
      kind: "while",
      condition,
      // `continue` in a for loop still runs the update step.
      body: [
        ...withStepBeforeContinue(withoutFinalContinue(lowerBlock(body, context)), step),
        ...step,
      ],
      span: node.span,
    },
  ];
}

function withStepBeforeContinue(statements: IrStatement[], step: IrStatement[]): IrStatement[] {
  return statements.flatMap((statement): IrStatement[] => {
    switch (statement.kind) {
      case "continue":
        return [...structuredClone(step), statement];
      case "if":
        return [
          {
            ...statement,
            then: withStepBeforeContinue(statement.then, step),
            else: withStepBeforeContinue(statement.else, step),
          },
        ];
      case "switch":
        return [
          {
            ...statement,
            cases: statement.cases.map((item) => ({
              ...item,
              body: withStepBeforeContinue(item.body, step),
            })),
            default: withStepBeforeContinue(statement.default, step),
          },
        ];
      default:
        // A continue inside a nested loop belongs to that loop.
        return [statement];
    }
  });
}

function lowerForControlExpression(node: AstNode, context: LowerContext): IrStatement[] | null {
  if (node.kind === "declaration") return lowerDeclaration(node, node.span, context);
  if (node.kind === "binary") return lowerAssignment(node, node.span, context);
  if (node.kind === "postfix") return lowerPostfix(node, node.span, context);
  return null;
}

function lowerSwitch(node: AstNode, context: LowerContext): IrStatement[] {
  const valueNode = asNode(node.expression);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  if (value === null)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_SWITCH_VALUE",
        "switch value could not be migrated.",
      ),
    ];

  const caseNodes = nodeArray(node.cases);
  const defaultNode = asNode(node.default);
  const defaultSource = switchBodyStatements(defaultNode);
  if (defaultSource === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_SWITCH_CASE",
        "Switch default body could not be migrated safely.",
      ),
    ];
  }

  const cases: IrSwitchCase[] = [];
  const matchNodes: AstNode[] = [];
  for (let index = 0; index < caseNodes.length; index += 1) {
    const caseNode = caseNodes[index]!;
    if (caseNode.kind !== "case")
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_SWITCH_CASE",
          "Unexpected Groovy switch case node.",
        ),
      ];
    const matchNode = asNode(caseNode.expression);
    const match = matchNode === null ? null : lowerExpression(matchNode, context);
    if (match === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_SWITCH_CASE",
          "Switch case could not be migrated safely.",
        ),
      ];
    }
    const sourceStatements = collectSwitchPath(caseNodes, index, defaultSource);
    if (sourceStatements === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_SWITCH_CASE",
          "Switch case body could not be migrated safely.",
        ),
      ];
    }
    const loweredBody = lowerStatementList(eliminateSwitchBreaks(sourceStatements), null, context);
    cases.push({ span: caseNode.span, match, body: loweredBody });
    matchNodes.push(matchNode!);
  }

  const defaultStatements = lowerStatementList(
    eliminateSwitchBreaks(withoutTerminalBreak(defaultSource)),
    null,
    context,
  );
  // A text case matched any subject whose text equals it (`"1"` matches 1); TeaseScript compares values.
  const subjectType = valueNode === null ? UNKNOWN : inferType(valueNode, context.types);
  const textCase = matchNodes.findIndex((matchNode) =>
    onlyOf(inferType(matchNode, context.types), STRING | NULL),
  );
  if (textCase >= 0 && onlyOf(subjectType, NUMBER | BOOLEAN | NULL) && subjectType !== NULL) {
    return [
      unsupportedStatement(
        context,
        matchNodes[textCase]!,
        "SX_SWITCH_CASE_MATCH",
        "Groovy matched this text case against the text of a non-text switch value; rewrite the case with the value's own type.",
      ),
    ];
  }
  if (isAcceptedSwitch(cases)) {
    return [{ kind: "switch", value, cases, default: defaultStatements, span: node.span }];
  }
  // Accepted switch cases are distinct literals or ranges; other Groovy cases become an equivalent if chain when
  // their isCase meaning is known from the case value: membership for lists and literal ranges, equality for
  // scalars. Groovy evaluated the switch value once, so case expressions with effects need a temporary.
  const listCases: boolean[] = [];
  for (let index = 0; index < cases.length; index += 1) {
    const match = cases[index]!.match;
    const type = inferType(matchNodes[index]!, context.types);
    // A Groovy range runs in either direction; bounds evaluated twice must be plain values.
    const boundsRepeatable = match.kind === "range" && [match.from, match.to].every(isPlainValue);
    const known =
      match.kind === "list" ||
      boundsRepeatable ||
      (match.kind !== "range" &&
        (onlyOf(type, LIST) || onlyOf(type, STRING | NUMBER | BOOLEAN | NULL)));
    if (!known) {
      return [
        unsupportedStatement(
          context,
          matchNodes[index]!,
          "SX_SWITCH_CASE_MATCH",
          "This switch case's Groovy isCase meaning depends on its runtime value (a list, a range in either direction, a class, a pattern, or a closure); rewrite the case as an explicit condition.",
        ),
      ];
    }
    listCases.push(match.kind !== "range" && onlyOf(type, LIST));
  }
  const subjectName = valueNode === null ? null : variableName(valueNode);
  const stableSubject =
    valueNode?.kind === "constant" ||
    (subjectName !== null &&
      (context.types.singleAssignment?.has(subjectName) === true ||
        context.stableNames.has(subjectName)));
  const repeatable =
    valueNode !== null &&
    isRepeatableExpression(valueNode) &&
    (stableSubject || matchNodes.every((matchNode) => isPure(matchNode, context)));
  context.switchValues += 1;
  const subject: IrExpression = repeatable
    ? value
    : { kind: "variable", name: `switchValue${context.switchValues}` };
  let chain: IrStatement[] = defaultStatements;
  for (let index = cases.length - 1; index >= 0; index -= 1) {
    const switchCase = cases[index]!;
    chain = [
      {
        kind: "if",
        condition: caseMatches(subject, switchCase.match, listCases[index]!),
        then: switchCase.body,
        else: chain,
        span: switchCase.span,
      },
    ];
  }
  return repeatable
    ? chain
    : [
        {
          kind: "let",
          name: subject.kind === "variable" ? subject.name : "switchValue",
          value,
          span: node.span,
        },
        ...chain,
      ];
}

function isAcceptedSwitch(cases: IrSwitchCase[]): boolean {
  const seen = new Set<string>();
  for (const { match } of cases) {
    const literal = (expression: IrExpression): boolean =>
      expression.kind === "literal" && expression.value !== null;
    const valid =
      literal(match) || (match.kind === "range" && literal(match.from) && literal(match.to));
    const key = JSON.stringify(match);
    if (!valid || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** Literals, variables, properties, and arithmetic on them: values that may be evaluated twice. */
function isPlainValue(expression: IrExpression): boolean {
  switch (expression.kind) {
    case "literal":
    case "variable":
      return true;
    case "property":
      return isPlainValue(expression.target);
    case "unary":
      return isPlainValue(expression.value);
    case "binary":
      return isPlainValue(expression.left) && isPlainValue(expression.right);
    default:
      return false;
  }
}

/** Groovy `isCase`: list membership, range bounds, or equality. */
function caseMatches(subject: IrExpression, match: IrExpression, isList = false): IrExpression {
  if (match.kind === "list" || isList)
    return { kind: "methodCall", target: match, name: "contains", arguments: [subject] };
  if (match.kind === "range") {
    const within = (low: IrExpression, high: IrExpression, upward: boolean): IrExpression => ({
      kind: "binary",
      operator: "and",
      left: { kind: "binary", operator: upward ? ">=" : "<=", left: subject, right: low },
      right: {
        kind: "binary",
        operator: upward ? (match.inclusive ? "<=" : "<") : match.inclusive ? ">=" : ">",
        left: subject,
        right: high,
      },
    });
    const { from, to } = match;
    if (from.kind === "literal" && to.kind === "literal") {
      const upward =
        typeof from.value === "number" && typeof to.value === "number"
          ? from.value <= to.value
          : true;
      return within(from, to, upward);
    }
    // A bound known only at runtime may make the range descend.
    return {
      kind: "binary",
      operator: "or",
      left: within(from, to, true),
      right: within(from, to, false),
    };
  }
  return { kind: "binary", operator: "==", left: subject, right: match };
}

/**
 * A Groovy `break` inside a switch case leaves the switch, also from inside an `if`. TeaseScript switch cases have
 * no `break`, so statements after an `if` that may break move into the paths that do not break; statements after
 * an unconditional `break` are unreachable.
 */
function eliminateSwitchBreaks(statements: AstNode[], rest: AstNode[] = []): AstNode[] {
  const result: AstNode[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    if (isSwitchBreak(statement)) return result;
    if (statement.kind === "block" && containsSwitchBreak(statement)) {
      return [
        ...result,
        ...eliminateSwitchBreaks(
          [...nodeArray(statement.statements), ...statements.slice(index + 1)],
          rest,
        ),
      ];
    }
    if (statement.kind === "if" && containsSwitchBreak(statement)) {
      const continuation = [...statements.slice(index + 1), ...rest];
      const branch = (node: unknown): AstNode => ({
        kind: "block",
        span: asNode(node)?.span ?? statement.span,
        statements: eliminateSwitchBreaks(branchStatements(node), continuation),
      });
      return [
        ...result,
        { ...statement, then: branch(statement.then), else: branch(statement.else) },
      ];
    }
    result.push(statement);
  }
  return [...result, ...rest];
}

function branchStatements(node: unknown): AstNode[] {
  const branch = asNode(node);
  if (branch === null || branch.kind === "empty") return [];
  return branch.kind === "block" ? nodeArray(branch.statements) : [branch];
}

/** A `break` that belongs to the enclosing switch, not to a nested loop, switch, or closure. */
function containsSwitchBreak(node: AstNode): boolean {
  if (isSwitchBreak(node)) return true;
  if (["for", "while", "switch", "closure"].includes(node.kind)) return false;
  return nodeChildren(node).some(containsSwitchBreak);
}

function collectSwitchPath(
  caseNodes: AstNode[],
  start: number,
  defaultSource: AstNode[],
): AstNode[] | null {
  const result: AstNode[] = [];
  for (let index = start; index < caseNodes.length; index += 1) {
    const body = switchBodyStatements(asNode(caseNodes[index]?.body));
    if (body === null) return null;
    const terminal = body.at(-1);
    result.push(...withoutTerminalBreak(body));
    if ((terminal !== undefined && isSwitchBreak(terminal)) || terminal?.kind === "return")
      return result;
  }
  result.push(...withoutTerminalBreak(defaultSource));
  return result;
}

function switchBodyStatements(node: AstNode | null): AstNode[] | null {
  if (node === null || node.kind === "empty") return [];
  return node.kind === "block" ? nodeArray(node.statements) : [node];
}

/** An unlabelled break, which leaves the innermost switch; a labelled break leaves an outer loop. */
function isSwitchBreak(node: AstNode): boolean {
  return node.kind === "break" && typeof node.label !== "string";
}

function withoutTerminalBreak(statements: AstNode[]): AstNode[] {
  const last = statements.at(-1);
  return last !== undefined && isSwitchBreak(last) ? statements.slice(0, -1) : statements;
}

function lowerReturnStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const valueNode = asNode(node.value);
  if (context.functionDepth > 0) {
    if (valueNode === null) return [{ kind: "return", value: null, span: node.span }];
    const value = lowerExpression(valueNode, context);
    if (value === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_FUNCTION_RETURN",
          "Function return value could not be migrated.",
        ),
      ];
    }
    return [{ kind: "return", value, span: node.span }];
  }

  if (valueNode === null || isNullConstant(valueNode)) return [{ kind: "end", span: node.span }];
  const script = lowerExpression(valueNode, context);
  if (script === null)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_SCRIPT_RETURN",
        "Script return value could not be migrated.",
      ),
    ];
  if (script.kind === "literal" && typeof script.value === "string")
    script.value = migrateScriptPath(script.value);
  return [{ kind: "run", script, span: node.span }];
}

function lowerExpression(node: AstNode, context: LowerContext): IrExpression | null {
  switch (node.kind) {
    case "constant":
      return isLiteral(node.value)
        ? { kind: "literal", value: node.value }
        : unsupportedExpression(
            context,
            node,
            "SX_UNSUPPORTED_CONSTANT",
            "Unsupported Groovy constant value.",
          );
    case "variable": {
      const name = variableName(node);
      if (name === null)
        return unsupportedExpression(
          context,
          node,
          "SX_INVALID_VARIABLE",
          "Variable is missing a name.",
        );
      if (name === "this") {
        return unsupportedExpression(
          context,
          node,
          "SX_OBJECT_THIS",
          "The legacy script object (this) cannot become a TeaseScript value.",
        );
      }
      if (context.helperMainParameter !== null && name === context.helperMainParameter) {
        return unsupportedExpression(
          context,
          node,
          "SX_HELPER_MAIN_VALUE",
          "The legacy SexScript host object cannot become an authored TeaseScript value.",
        );
      }
      if (
        context.functions.has(name) &&
        !context.shadowingReferences.has(node) &&
        !isVisibleLocal(name, node, context)
      ) {
        // A function used as a value becomes its action ID, like a closure value.
        context.actions.add(name);
        return { kind: "literal", value: name, action: true };
      }
      return { kind: "variable", name };
    }
    case "list": {
      const items: IrExpression[] = [];
      for (const child of nodeArray(node.items)) {
        const value = lowerExpression(child, context);
        if (value === null) return null;
        items.push(value);
      }
      return { kind: "list", items };
    }
    case "map":
      return lowerMapExpression(node, context);
    case "gstring":
      return lowerGString(node, context);
    case "array":
      return lowerArrayExpression(node, context);
    case "constructorCall":
      if (isCurrentDateConstructor(node)) {
        return { kind: "call", name: "getDateTime", positional: [], named: {} };
      }
      return unsupportedExpression(
        context,
        node,
        "SX_JAVA_CONSTRUCTOR",
        `Java object construction (new ${text(node.type) ?? "?"}) has no TeaseScript equivalent.`,
      );
    case "closure":
      return lowerClosureValue(node, context);
    case "property":
      return lowerPropertyExpression(node, context);
    case "range": {
      const fromNode = asNode(node.from);
      const toNode = asNode(node.to);
      const from = fromNode === null ? null : lowerExpression(fromNode, context);
      const to = toNode === null ? null : lowerExpression(toNode, context);
      if (from === null || to === null) return null;
      return { kind: "range", from, to, inclusive: node.inclusive === true };
    }
    case "binary":
      return lowerBinaryExpression(node, context);
    case "boolean":
      return asNode(node.value) === null ? null : lowerExpression(asNode(node.value)!, context);
    case "cast":
      return lowerCast(node, context);
    case "not": {
      const valueNode = asNode(node.value);
      const value = valueNode === null ? null : lowerCondition(valueNode, context);
      return value === null ? null : negate(value);
    }
    case "unaryMinus":
      return lowerUnary(node, "-", context);
    case "unaryPlus":
      return lowerUnary(node, "+", context);
    case "methodCall":
      return lowerMethodCallExpression(node, context);
    case "postfix":
      return lowerPostfixValue(node, context);
    default:
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_EXPRESSION",
        `Unsupported Groovy expression: ${node.kind}`,
      );
  }
}

/**
 * `save("k", count++)` uses the old value and then increments. When nothing else in the statement can observe the
 * variable, the value is the variable itself and the increment follows the statement.
 */
function lowerPostfixValue(node: AstNode, context: LowerContext): IrExpression | null {
  const name = variableName(asNode(node.value));
  const operator = node.operator === "++" ? "+=" : node.operator === "--" ? "-=" : null;
  const root = context.statementRoot;
  if (
    name === null ||
    operator === null ||
    root === null ||
    root !== context.postludeRoot ||
    root.kind !== "expressionStatement" ||
    !incrementsAfterStatement(root, node, name, context)
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_INCREMENT_POSITION",
      "This ++/-- result is used where the increment cannot simply follow the statement: the variable is used again in the statement, the increment is guarded by && / || / ?:, or a function called in the statement could read the variable. Move the increment to its own statement.",
    );
  }
  context.postlude.push({
    kind: "assign",
    target: { kind: "variable", name },
    operator,
    value: { kind: "literal", value: 1 },
    span: node.span,
  });
  return { kind: "variable", name };
}

function incrementsAfterStatement(
  root: AstNode,
  target: AstNode,
  name: string,
  context: LowerContext,
): boolean {
  const local = context.currentFunction?.locals.has(name) === true;
  let safe = true;
  let found = false;
  const visit = (node: AstNode, guarded: boolean): void => {
    if (node === target) {
      found = true;
      if (guarded) safe = false;
      return;
    }
    if (node.kind === "closure") {
      safe = false;
      return;
    }
    if (variableName(node) === name) safe = false;
    if (node.kind === "methodCall") {
      const call = callParts(node);
      const helperClass = context.legacyHelperClasses.has(variableName(asNode(node.object)) ?? "");
      const readsScriptVariables =
        call === null ||
        (call.inherited
          ? legacyApiCall(node, context) === null
          : !helperClass && !PURE_OBJECT_METHODS.has(call.name));
      // Other functions can see the variable only when it is not a local of the current function.
      if (readsScriptVariables && !local) safe = false;
    }
    const guardedChildren = new Set<unknown>();
    if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
      guardedChildren.add(node.right);
    } else if (node.kind === "ternary") {
      guardedChildren.add(node.true);
      guardedChildren.add(node.false);
    } else if (node.kind === "elvis") {
      guardedChildren.add(node.false);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, guarded || guardedChildren.has(value));
      }
    }
  };
  visit(root, false);
  return found && safe;
}

/** Groovy GString `"a ${b} c"` interleaves constant strings and values, starting with a string. */
function lowerGString(node: AstNode, context: LowerContext): IrExpression | null {
  const strings = Array.isArray(node.strings) ? node.strings : [];
  const values = nodeArray(node.values);
  const parts: Array<{ text: string } | { value: IrExpression }> = [];
  for (let index = 0; index < Math.max(strings.length, values.length); index += 1) {
    const text: unknown = strings[index];
    if (typeof text === "string" && text !== "") parts.push({ text });
    const valueNode = values[index];
    if (valueNode === undefined) continue;
    const valueType = inferType(valueNode, context.types);
    if (onlyOf(valueType, LIST | NULL) && valueType & LIST) {
      return unsupportedExpression(
        context,
        valueNode,
        "SX_COLLECTION_TEXT",
        "Groovy turned this list into text like [a, b]; TeaseScript interpolation shows one random element instead. Format the list explicitly.",
      );
    }
    const value = lowerExpression(valueNode, context);
    if (value === null) return null;
    parts.push({ value });
  }
  return templateOrLiteral(parts);
}

function lowerMapExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const properties: Array<{ name: string; value: IrExpression }> = [];
  for (const entry of nodeArray(node.entries)) {
    if (entry.kind !== "mapEntry") {
      return unsupportedExpression(
        context,
        node,
        "SX_MAP_ENTRY",
        "Groovy map contains an invalid entry.",
      );
    }
    const name = constantString(entry.key);
    const valueNode = asNode(entry.value);
    if (name === null || !isTeaseObjectPropertyName(name)) {
      return unsupportedExpression(
        context,
        entry,
        "SX_DYNAMIC_MAP_KEY",
        "Only static identifier-like Groovy map keys lower to TeaseScript object properties.",
      );
    }
    const value = valueNode === null ? null : lowerExpression(valueNode, context);
    if (value === null) return null;
    properties.push({ name, value });
  }
  return { kind: "object", properties };
}

function isTeaseObjectPropertyName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function lowerBinaryExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const operator = text(node.operator);
  if (operator === "[") {
    const targetNode = asNode(node.left);
    const indexNode = asNode(node.right);
    const target = targetNode === null ? null : lowerExpression(targetNode, context);
    if (target === null || indexNode === null) return null;
    const negativeIndex = negativeConstantIndex(indexNode);
    if (
      negativeIndex !== null &&
      targetNode !== null &&
      isKnownListExpression(targetNode, context)
    ) {
      // Groovy negative indexes count from the end; TeaseScript indexes start at 0 only.
      if (negativeIndex === 1) return { kind: "property", target, name: "last" };
      if (isRepeatableExpression(targetNode) || isPure(targetNode, context)) {
        return {
          kind: "index",
          target,
          index: {
            kind: "binary",
            operator: "-",
            left: { kind: "property", target, name: "length" },
            right: { kind: "literal", value: negativeIndex },
          },
        };
      }
    }
    if (negativeIndex !== null) {
      return unsupportedExpression(
        context,
        node,
        "SX_NEGATIVE_INDEX",
        "Groovy counted this negative index from the end; the receiver is not proven to be a list or cannot be evaluated twice. Index from the end explicitly.",
      );
    }
    // `date[Calendar.MONTH]` reads a date field only on a current date; elsewhere the constant is a number.
    const calendarIndex = calendarConstant(indexNode);
    if (calendarIndex !== null && targetNode !== null && isCurrentDateValue(targetNode, context)) {
      return dateTimeField(calendarIndex, target, node, context);
    }
    if (targetNode !== null && isRandomIndexOf(indexNode, targetNode, context)) {
      // `items[getRandom(items.size())]` picks one element uniformly, which is TeaseScript `items.random`.
      return { kind: "property", target, name: "random" };
    }
    const propertyName = constantString(indexNode);
    if (propertyName !== null) {
      if (!isTeaseObjectPropertyName(propertyName)) {
        return unsupportedExpression(
          context,
          node,
          "SX_DYNAMIC_MAP_KEY",
          `Groovy map key ${JSON.stringify(propertyName)} is not a TeaseScript object property name.`,
        );
      }
      return { kind: "property", target, name: propertyName };
    }
    const index = lowerExpression(indexNode, context);
    return index === null ? null : { kind: "index", target, index };
  }
  if (operator === "&&" || operator === "||") {
    const leftNode = asNode(node.left);
    const rightNode = asNode(node.right);
    const left = leftNode === null ? null : lowerCondition(leftNode, context);
    const right = rightNode === null ? null : lowerCondition(rightNode, context);
    if (left === null || right === null) return null;
    return { kind: "binary", operator: operator === "&&" ? "and" : "or", left, right };
  }
  if (operator === "+") return lowerPlus(node, context);
  if (operator === "in") return lowerMembership(node, context);
  if ((operator === "&" || operator === "|") && isBooleanOperation(node, context)) {
    // Groovy & and | on booleans evaluate both sides; with a side-effect-free right side that equals and/or.
    const left = lowerCondition(asNode(node.left)!, context);
    const right = lowerCondition(asNode(node.right)!, context);
    if (left === null || right === null) return null;
    return { kind: "binary", operator: operator === "&" ? "and" : "or", left, right };
  }
  const mapped = operator;
  if (operator === "=") {
    return unsupportedExpression(
      context,
      node,
      "SX_ASSIGNMENT_VALUE",
      "An assignment is used as a value here (Groovy assigned, then used the assigned value, for example as a condition); this is often a mistake for ==. Make the assignment its own statement.",
    );
  }
  if (
    mapped === null ||
    !new Set(["==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "and", "or"]).has(mapped)
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_UNSUPPORTED_OPERATOR",
      `Groovy operator ${operator ?? "?"} is not safely mapped yet.`,
    );
  }
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  const left = leftNode === null ? null : lowerExpression(leftNode, context);
  const right = rightNode === null ? null : lowerExpression(rightNode, context);
  return left === null || right === null ? null : { kind: "binary", operator: mapped, left, right };
}

/**
 * Lowers a Groovy condition to an explicitly boolean TeaseScript expression. Groovy treats null, zero, empty
 * strings, and empty collections as false; TeaseScript conditions must already be boolean.
 */
function lowerCondition(node: AstNode, context: LowerContext): IrExpression | null {
  if (node.kind === "boolean") {
    const inner = asNode(node.value);
    return inner === null ? null : lowerCondition(inner, context);
  }
  if (isUncalledClosure(node, context)) {
    addDiagnostic(
      context,
      "SX_CLOSURE_NOT_CALLED",
      "warning",
      `Groovy treated closure ${variableName(node)} itself as true here because it was not called; kept as true. Use ${variableName(node)}() if a call was intended.`,
      node.span,
    );
    return { kind: "literal", value: true };
  }
  const legacyLoad = typedLegacyLoad(node, context);
  if (legacyLoad !== null && isPure(legacyLoad.key, context)) {
    // A missing key (or a stored null) reads as null, which Groovy treats like the type's false value.
    const key = lowerExpression(legacyLoad.key, context);
    if (key === null) return null;
    const read = (): IrExpression => ({ kind: "load", key });
    if (legacyLoad.falseValue.value === false) {
      return {
        kind: "binary",
        operator: "==",
        left: read(),
        right: { kind: "literal", value: true },
      };
    }
    return {
      kind: "binary",
      operator: "and",
      left: {
        kind: "binary",
        operator: "!=",
        left: read(),
        right: { kind: "literal", value: null },
      },
      right: { kind: "binary", operator: "!=", left: read(), right: legacyLoad.falseValue },
    };
  }
  const value = lowerExpression(node, context);
  if (value === null) return null;
  return truthiness(
    value,
    inferType(node, context.types),
    isRepeatableExpression(node) || isRepeatableIndex(node),
    node,
    context,
  );
}

/** Groovy truth of a lowered value of the given legacy type, as an explicit boolean expression. */
function truthiness(
  value: IrExpression,
  type: number,
  repeatable: boolean,
  node: AstNode,
  context: LowerContext,
): IrExpression | null {
  if (onlyOf(type, BOOLEAN)) return value;
  const compare = (operator: string, right: IrExpression): IrExpression => ({
    kind: "binary",
    operator,
    left: value,
    right,
  });
  const notNull = compare("!=", { kind: "literal", value: null });
  const and = (left: IrExpression, right: IrExpression): IrExpression => ({
    kind: "binary",
    operator: "and",
    left,
    right,
  });
  if (onlyOf(type, BOOLEAN | NULL)) return compare("==", { kind: "literal", value: true });
  if (type === NULL) return notNull;
  if ((type & OBJECT) !== 0 && onlyOf(type, OBJECT | NULL)) {
    return unsupportedExpression(
      context,
      node,
      "SX_MAP_TRUTHINESS",
      "Groovy treats an empty map as false; TeaseScript records have no emptiness test and a record is not a condition. Test a specific field or keep an explicit flag.",
    );
  }
  if (onlyOf(type, NUMBER)) return compare("!=", { kind: "literal", value: 0 });
  if (onlyOf(type, STRING)) return compare("!=", { kind: "literal", value: "" });
  if (onlyOf(type, LIST)) {
    return {
      kind: "binary",
      operator: ">",
      left: { kind: "property", target: value, name: "length" },
      right: { kind: "literal", value: 0 },
    };
  }
  if (repeatable && onlyOf(type, NUMBER | NULL)) {
    return and(notNull, compare("!=", { kind: "literal", value: 0 }));
  }
  if (repeatable && onlyOf(type, STRING | NULL)) {
    return and(notNull, compare("!=", { kind: "literal", value: "" }));
  }
  addDiagnostic(
    context,
    "SX_CONDITION_TYPE",
    "warning",
    "Condition is not proven boolean; TeaseScript conditions must be boolean, unlike Groovy truthiness. Verify or compare explicitly.",
    node.span,
  );
  return value;
}

/** Typed legacy loads whose missing-key null maps to the type's false value in a condition. */
function typedLegacyLoad(
  node: AstNode,
  context: LowerContext,
): { key: AstNode; falseValue: { kind: "literal"; value: boolean | number | string } } | null {
  const call = legacyApiCall(node, context);
  if (call === null || call.arguments.length !== 1) return null;
  const falseValues: Record<string, boolean | number | string> = {
    loadBoolean: false,
    loadInteger: 0,
    loadFloat: 0,
    loadString: "",
  };
  const falseValue = falseValues[call.name];
  return falseValue === undefined
    ? null
    : { key: call.arguments[0]!, falseValue: { kind: "literal", value: falseValue } };
}

function isRepeatableIndex(node: AstNode): boolean {
  if (node.kind === "property") return isRepeatableExpression(node);
  const target = asNode(node.left);
  const index = asNode(node.right);
  return (
    node.kind === "binary" &&
    node.operator === "[" &&
    target !== null &&
    index !== null &&
    isRepeatableExpression(target) &&
    isRepeatableExpression(index)
  );
}

/** Expressions that may be evaluated twice without changing behavior or readability much. */
function isRepeatableExpression(node: AstNode): boolean {
  if (node.kind === "variable" || node.kind === "constant") return true;
  if (node.kind === "property") {
    const target = asNode(node.object);
    return target !== null && isRepeatableExpression(target);
  }
  return false;
}

/**
 * Groovy `+` concatenates when either operand is a string; TeaseScript `+` is numeric only, so string
 * concatenation becomes interpolation. Left-associative chains such as `1 + 2 + "x"` keep their numeric prefix.
 */
function lowerPlus(node: AstNode, context: LowerContext): IrExpression | null {
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  if (leftNode === null || rightNode === null) return null;
  if (onlyOf(inferType(node, context.types), STRING)) {
    const parts = concatenationParts(node, context);
    return parts === null ? null : templateOrLiteral(parts);
  }
  const leftType = inferType(leftNode, context.types);
  const rightType = inferType(rightNode, context.types);
  if (isListType(leftType)) {
    // Decided before lowering, so each operand is lowered (and its prompts emitted) exactly once.
    const lists = listConcatenationOperands(node, context);
    if (lists === null) return null;
    return useHelper(context, "concat", [{ kind: "list", items: lists }]);
  }
  const left = lowerExpression(leftNode, context);
  const right = lowerExpression(rightNode, context);
  if (left === null || right === null) return null;
  // `month - 1 + 1` arises from Java's zero-based Calendar.MONTH idiom; keep the plain value.
  if (
    left.kind === "binary" &&
    left.operator === "-" &&
    left.left.kind === "property" &&
    left.left.name === "month" &&
    left.right.kind === "literal" &&
    right.kind === "literal" &&
    typeof right.value === "number" &&
    left.right.value === right.value
  ) {
    return left.left;
  }
  // A null operand fails in both languages, so only non-numeric possibilities need review.
  if (!onlyOf(leftType, NUMBER | NULL) || !onlyOf(rightType, NUMBER | NULL)) {
    addDiagnostic(
      context,
      "SX_PLUS_OPERAND_TYPE",
      "warning",
      "Groovy + operands are not proven numeric; TeaseScript + only adds numbers. Use interpolation if this joins text.",
      node.span,
    );
  }
  return { kind: "binary", operator: "+", left, right };
}

/** A null list operand fails in Groovy and TeaseScript alike, so "list or null" counts as a list. */
function isListType(type: number): boolean {
  return onlyOf(type, LIST | NULL) && (type & LIST) !== 0;
}

/** Flattens `a + b + c` on lists into one operand list for the concatenation helper. */
function listConcatenationOperands(node: AstNode, context: LowerContext): IrExpression[] | null {
  if (node.kind === "binary" && node.operator === "+") {
    const leftNode = asNode(node.left);
    const rightNode = asNode(node.right);
    if (leftNode !== null && rightNode !== null && isListType(inferType(leftNode, context.types))) {
      // Groovy `list + element` appends one element; `list + otherList` appends all elements, so the right
      // side must be proven one or the other (a null right side is appended as an element).
      const rightType = inferType(rightNode, context.types);
      const rightIsList = onlyOf(rightType, LIST);
      const rightIsElement = (rightType & (LIST | NULL)) === 0 && rightType !== 0;
      if (!rightIsList && !rightIsElement) {
        unsupportedExpression(
          context,
          rightNode,
          "SX_LIST_CONCATENATION",
          "Groovy list + appends a list's elements or a single value; the type of this right side is not proven, so convert it manually.",
        );
        return null;
      }
      const left = listConcatenationOperands(leftNode, context);
      const right = lowerExpression(rightNode, context);
      if (left === null || right === null) return null;
      return [...left, rightIsList ? right : { kind: "list", items: [right] }];
    }
  }
  const value = lowerExpression(node, context);
  return value === null ? null : [value];
}

type TemplatePart = { text: string } | { value: IrExpression };

function concatenationParts(node: AstNode, context: LowerContext): TemplatePart[] | null {
  if (node.kind === "binary" && node.operator === "+") {
    const leftNode = asNode(node.left);
    const rightNode = asNode(node.right);
    if (leftNode !== null && rightNode !== null && onlyOf(inferType(node, context.types), STRING)) {
      const left = concatenationParts(leftNode, context);
      const right = concatenationParts(rightNode, context);
      return left === null || right === null ? null : [...left, ...right];
    }
  }
  const valueType = inferType(node, context.types);
  if (onlyOf(valueType, LIST | NULL) && valueType & LIST) {
    // Groovy prints the whole list ("[a, b]"); TeaseScript visible-text interpolation picks one element.
    return unsupportedExpression(
      context,
      node,
      "SX_COLLECTION_TEXT",
      "Groovy turned this list into text like [a, b]; TeaseScript interpolation shows one random element instead. Format the list explicitly.",
    );
  }
  const value = lowerExpression(node, context);
  if (value === null) return null;
  if (value.kind === "literal" && typeof value.value === "string") return [{ text: value.value }];
  if (value.kind === "template") return value.parts;
  return [{ value }];
}

function templateOrLiteral(parts: TemplatePart[]): IrExpression {
  const merged: TemplatePart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if ("text" in part && previous !== undefined && "text" in previous) {
      merged[merged.length - 1] = { text: previous.text + part.text };
    } else if (!("text" in part) || part.text !== "") {
      merged.push(part);
    }
  }
  if (merged.length === 0) return { kind: "literal", value: "" };
  const only = merged[0];
  if (merged.length === 1 && only !== undefined && "text" in only) {
    return { kind: "literal", value: only.text };
  }
  return { kind: "template", parts: merged };
}

function isBooleanOperation(node: AstNode, context: LowerContext): boolean {
  const left = asNode(node.left);
  const right = asNode(node.right);
  return (
    left !== null &&
    right !== null &&
    isPure(right, context) &&
    onlyOf(inferType(left, context.types), BOOLEAN) &&
    onlyOf(inferType(right, context.types), BOOLEAN)
  );
}

/** `x in list` tests membership; `x in a..b` tests the range bounds. */
function lowerMembership(node: AstNode, context: LowerContext): IrExpression | null {
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  if (leftNode === null || rightNode === null) return null;
  const value = lowerExpression(leftNode, context);
  if (value === null) return null;
  if (rightNode.kind === "range" && isRepeatableExpression(leftNode)) {
    const from = asNode(rightNode.from);
    const to = asNode(rightNode.to);
    const lower = from === null ? null : lowerExpression(from, context);
    const upper = to === null ? null : lowerExpression(to, context);
    if (lower === null || upper === null) return null;
    return {
      kind: "binary",
      operator: "and",
      left: { kind: "binary", operator: ">=", left: value, right: lower },
      right: {
        kind: "binary",
        operator: rightNode.inclusive === true ? "<=" : "<",
        left: value,
        right: upper,
      },
    };
  }
  if (isKnownListExpression(rightNode, context)) {
    const list = lowerExpression(rightNode, context);
    return list === null
      ? null
      : { kind: "methodCall", target: list, name: "contains", arguments: [value] };
  }
  return unsupportedExpression(
    context,
    node,
    "SX_UNSUPPORTED_OPERATOR",
    "Groovy `in` is only converted for lists and ranges.",
  );
}

/** `-n` as an index literal (Groovy parses it as unary minus applied to a constant). */
function negativeConstantIndex(node: AstNode): number | null {
  const value = node.kind === "unaryMinus" ? asNode(node.value) : null;
  if (value?.kind === "constant" && typeof value.value === "number" && value.value > 0)
    return value.value;
  if (node.kind === "constant" && typeof node.value === "number" && node.value < 0)
    return -node.value;
  return null;
}

/** Recognizes `getRandom(list.size)`, `getRandom(list.size())`, or `getRandom(list.length)` for `list`. */
function isRandomIndexOf(index: AstNode, list: AstNode, context: LowerContext): boolean {
  const call = legacyApiCall(index, context);
  if (call === null || call.name !== "getRandom" || call.arguments.length !== 1) return false;
  const bound = call.arguments[0]!;
  const sizeName =
    bound.kind === "property"
      ? constantString(bound.property)
      : callParts(bound)?.arguments.length === 0
        ? constantString(bound.method)
        : null;
  if (sizeName !== "size" && sizeName !== "length") return false;
  const receiver = asNode(bound.object);
  return receiver !== null && sameReference(receiver, list);
}

function sameReference(left: AstNode, right: AstNode): boolean {
  if (left.kind === "variable" && right.kind === "variable") {
    return variableName(left) === variableName(right);
  }
  if (left.kind === "property" && right.kind === "property") {
    const leftObject = asNode(left.object);
    const rightObject = asNode(right.object);
    return (
      constantString(left.property) === constantString(right.property) &&
      leftObject !== null &&
      rightObject !== null &&
      sameReference(leftObject, rightObject)
    );
  }
  return false;
}

function lowerCast(node: AstNode, context: LowerContext): IrExpression | null {
  const valueNode = asNode(node.value);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  if (value === null) return null;
  switch (text(node.type)) {
    case "int":
    case "Integer":
    case "long":
    case "Long":
      return { kind: "call", name: "toInteger", positional: [value], named: {} };
    case "float":
    case "Float":
    case "double":
    case "Double":
    case "BigDecimal":
      return { kind: "call", name: "toNumber", positional: [value], named: {} };
    case "String":
    case "java.lang.String":
      return { kind: "call", name: "toString", positional: [value], named: {} };
    case "Boolean":
    case "boolean":
      return { kind: "call", name: "toBoolean", positional: [value], named: {} };
    case "List":
    case "java.util.List":
      return value.kind === "list"
        ? value
        : unsupportedExpression(
            context,
            node,
            "SX_UNSUPPORTED_CAST",
            "Only literal-list List casts are erased safely.",
          );
    default:
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_CAST",
        `Groovy cast to ${text(node.type) ?? "unknown"} is not mapped.`,
      );
  }
}

function lowerUnary(
  node: AstNode,
  operator: "not" | "+" | "-",
  context: LowerContext,
): IrExpression | null {
  const valueNode = asNode(node.value);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  return value === null ? null : { kind: "unary", operator, value };
}

function lowerPropertyExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const targetNode = asNode(node.object);
  const property = constantString(node.property);
  if (targetNode === null || property === null) {
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_PROPERTY",
      "Dynamic Groovy property access is not lowered automatically.",
    );
  }
  if (
    (property === "size" || property === "length") &&
    isKnownListExpression(targetNode, context)
  ) {
    const target = lowerExpression(targetNode, context);
    return target === null ? null : { kind: "property", target, name: "length" };
  }
  if (!isRecordFieldAccess(targetNode, property, context)) {
    return unsupportedExpression(
      context,
      node,
      "SX_UNSUPPORTED_PROPERTY",
      `Groovy property .${property} is not safely mapped for this receiver.`,
    );
  }
  const target = lowerExpression(targetNode, context);
  if (target === null) return null;
  if (!onlyOf(inferType(targetNode, context.types), OBJECT | NULL)) {
    addDiagnostic(
      context,
      "SX_FIELD_ASSUMED",
      "info",
      `Read .${property} as an object field; a missing field fails in TeaseScript where a Groovy map returned null.`,
      node.span,
    );
  }
  return { kind: "property", target, name: property };
}

/**
 * Groovy `value.name` on a map (the importer's object/record representation) is a field read. Class-like
 * receivers (`Calendar.MONTH`, `System.out`) and lists are not records.
 */
function isRecordFieldAccess(target: AstNode, property: string, context: LowerContext): boolean {
  if (!isTeaseObjectPropertyName(property)) return false;
  const receiver = variableName(target);
  if (receiver !== null && /^[A-Z]/u.test(receiver) && !context.types.variables.has(receiver))
    return false;
  if (target.kind === "constructorCall" || target.kind === "classExpression") return false;
  const type = inferType(target, context.types);
  return (type & OBJECT) !== 0 && !onlyOf(type, LIST | NULL);
}

function lowerObjectMethodCallExpression(
  node: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null {
  const targetNode = asNode(node.object);
  const receiverName = targetNode === null ? null : variableName(targetNode);
  const helperClass =
    receiverName === null ? undefined : context.legacyHelperClasses.get(receiverName);
  if (helperClass !== undefined) {
    const helperInfo = context.packageHelperRegistry.get(helperClass)?.get(name);
    if (helperInfo === undefined) {
      return unsupportedExpression(
        context,
        node,
        "SX_LEGACY_HELPER_CALL",
        `Legacy helper ${helperClass}.${name}() has no discovered package-local method to migrate.`,
      );
    }
    let argumentNodes = argumentsNodes;
    if (helperInfo.stripsMain) {
      if (variableName(argumentNodes[0]) !== "this") {
        return unsupportedExpression(
          context,
          node,
          "SX_HELPER_MAIN_ARGUMENT",
          `Legacy helper ${helperClass}.${name}() is called without the script host (this) as its first argument; no method matched, so SexScript failed here at runtime.`,
        );
      }
      argumentNodes = argumentNodes.slice(1);
    }
    if (argumentNodes.length < helperInfo.minArgs || argumentNodes.length > helperInfo.maxArgs) {
      return unsupportedExpression(
        context,
        node,
        "SX_FUNCTION_ARITY",
        `Call to ${helperClass}.${name} has ${argumentNodes.length} authored arguments; expected ${helperInfo.minArgs}..${helperInfo.maxArgs}, so SexScript failed here at runtime.`,
      );
    }
    const args = lowerArguments(argumentNodes, context);
    return args === null ? null : { kind: "call", name, positional: args, named: {}, local: true };
  }

  if (name === "call" && targetNode !== null) {
    const action = lowerExpression(targetNode, context);
    const args = lowerArguments(argumentsNodes, context);
    return action === null || args === null ? null : actionCall(action, args, context);
  }
  if (name === "toString" && argumentsNodes.length === 0 && targetNode !== null) {
    const value = lowerExpression(targetNode, context);
    return value === null ? null : templateOrLiteral([{ value }]);
  }
  if (receiverName === "Math") {
    const helper = MATH_HELPERS.get(name);
    if (helper !== undefined && argumentsNodes.length === helper.arity) {
      const args = lowerArguments(argumentsNodes, context);
      return args === null ? null : useHelper(context, helper.name, args);
    }
    if ((name === "ceil" || name === "floor") && argumentsNodes.length === 1) {
      const args = lowerArguments(argumentsNodes, context);
      return args === null ? null : { kind: "call", name, positional: args, named: {} };
    }
    if (name === "round" && argumentsNodes.length === 1) {
      const args = lowerArguments(argumentsNodes, context);
      if (args === null) return null;
      addDiagnostic(
        context,
        "SX_ROUNDING_TIES",
        "warning",
        "Java Math.round() rounds .5 toward positive infinity (-1.5 becomes -1); TeaseScript round() does not specify its tie rule yet.",
        node.span,
      );
      return { kind: "call", name: "round", positional: args, named: {} };
    }
  }
  const calendarField = name === "get" ? calendarGetField(targetNode, argumentsNodes) : null;
  if (calendarField !== null)
    return dateTimeField(
      calendarField,
      { kind: "call", name: "getDateTime", positional: [], named: {} },
      node,
      context,
    );
  if (receiverName === "System" && name === "exit") {
    return unsupportedExpression(
      context,
      node,
      "SX_JVM_PROCESS_CONTROL",
      "System.exit() terminates the legacy JVM process and is not automatically equivalent to TeaseScript exit.",
    );
  }
  if (
    JAVA_REFLECTION_METHODS.has(name) ||
    (name === "forName" && receiverName === "Class") ||
    (name === "get" && targetNode?.kind === "methodCall")
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_REFLECTION",
      "Java reflection has no TeaseScript equivalent; reimplement the intended behavior manually.",
    );
  }
  if (
    name === "format" &&
    targetNode !== null &&
    (targetNode.kind === "constructorCall" || isCurrentDateConstructor(targetNode))
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_DATE_FORMAT",
      "Java date pattern formatting has no TeaseScript equivalent; keep typed date/datetime values (compare them or store them directly) or display them with formatDate()/formatTime().",
    );
  }
  if (targetNode?.kind === "constructorCall") {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_OBJECT_CALL",
      `Method ${name}() on a constructed Java object requires manual or helper migration.`,
    );
  }

  if (
    targetNode !== null &&
    STRING_METHODS.has(name) &&
    !isKnownListExpression(targetNode, context)
  ) {
    if (context.proposals.has("string-operations")) {
      const proposed = proposedStringOperation(node, targetNode, name, argumentsNodes, context);
      if (proposed !== undefined) return proposed;
    }
    return unsupportedExpression(
      context,
      node,
      "SX_STRING_METHOD",
      `Groovy string method ${name}() has no TeaseScript equivalent yet (no accepted string library); rewrite this text handling manually.`,
    );
  }
  if (targetNode === null || !isKnownListExpression(targetNode, context)) {
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_OR_OBJECT_CALL",
      "Object/dynamic Groovy method calls are not lowered by the first slice.",
    );
  }
  const target = lowerExpression(targetNode, context);
  if (target === null) return null;
  if (name === "size" && argumentsNodes.length === 0) {
    return { kind: "property", target, name: "length" };
  }
  if ((name === "contains" || name === "add") && argumentsNodes.length === 1) {
    if (name === "add") noteSharedListWrite(targetNode, node, context);
    const args = lowerArguments(argumentsNodes, context);
    return args === null ? null : { kind: "methodCall", target, name, arguments: args };
  }
  if (name === "indexOf" && argumentsNodes.length === 1) {
    const args = lowerArguments(argumentsNodes, context);
    if (args === null) return null;
    return useHelper(context, "indexOf", [target, args[0]!]);
  }
  if (argumentsNodes.length === 0) {
    switch (name) {
      case "isEmpty":
        return {
          kind: "binary",
          operator: "==",
          left: { kind: "property", target, name: "length" },
          right: { kind: "literal", value: 0 },
        };
      case "first":
      case "last":
        return { kind: "property", target, name };
      case "toList":
        return target;
      case "max":
        return useHelper(context, "listMax", [target]);
      case "min":
        return useHelper(context, "listMin", [target]);
      case "sum":
        // Groovy sum() joins text; the helper adds numbers only.
        if (!onlyOf(listElementType(targetNode, context), NUMBER)) {
          return unsupportedExpression(
            context,
            node,
            "SX_LIST_SUM_TYPE",
            "Groovy sum() adds numbers but joins text and other values; this list is not proven to hold only numbers. Add the elements explicitly.",
          );
        }
        return useHelper(context, "listSum", [target]);
      case "unique":
        // Groovy unique() also deduplicates the receiver in place; as an expression only the result is kept.
        return useHelper(context, "unique", [target]);
      case "join":
        return useHelper(context, "join", [target, { kind: "literal", value: "" }]);
    }
  }
  if (name === "join" && argumentsNodes.length === 1) {
    const separator = lowerExpression(argumentsNodes[0]!, context);
    return separator === null ? null : useHelper(context, "join", [target, separator]);
  }
  return unsupportedExpression(
    context,
    node,
    "SX_UNSUPPORTED_LIST_METHOD",
    `Groovy list method ${name}() is not safely mapped yet.`,
  );
}

/**
 * Groovy string methods as proposed built-in string operations (string-operations, #508), in a working syntax that
 * follows the list members: `text.length` like `items.length`, verbs such as `text.trim()` like `items.sort()`. The
 * length also counts list elements, so receivers that may be text or a list need no proof; receivers that may be
 * maps need the dictionaries proposal, which counts keys. Returns undefined for methods or arguments the working
 * syntax does not cover (regular expressions, tokenize).
 */
function proposedStringOperation(
  node: AstNode,
  targetNode: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null | undefined {
  const mayBeMap = (inferType(targetNode, context.types) & OBJECT) !== 0;
  const member = (operation: string, args: IrExpression[], target: IrExpression): IrExpression => ({
    kind: "methodCall",
    target,
    name: operation,
    arguments: args,
    proposed: "string-operations",
  });
  const literalText = (argument: AstNode | undefined): string | null => {
    const value = argument === undefined ? undefined : constantValue(argument);
    return typeof value === "string" ? value : null;
  };
  let operation: string;
  switch (name) {
    case "size":
    case "length": {
      if (argumentsNodes.length !== 0) return undefined;
      if (mayBeMap && !context.proposals.has("dictionaries")) return undefined;
      const target = lowerExpression(targetNode, context);
      return target === null
        ? null
        : { kind: "property", target, name: "length", proposed: "string-operations" };
    }
    case "toUpperCase":
    case "toLowerCase":
    case "capitalize":
    case "trim":
      if (argumentsNodes.length !== 0) return undefined;
      operation = name === "toUpperCase" ? "upper" : name === "toLowerCase" ? "lower" : name;
      break;
    case "startsWith":
    case "endsWith":
    case "replace":
      if (argumentsNodes.length !== (name === "replace" ? 2 : 1)) return undefined;
      operation = name;
      break;
    case "replaceAll": {
      // Java replaceAll() takes a regular expression and a replacement pattern; only plain text is covered.
      const pattern = literalText(argumentsNodes[0]);
      const replacement = literalText(argumentsNodes[1]);
      if (argumentsNodes.length !== 2 || pattern === null || replacement === null) return undefined;
      if (/[\\^$.|?*+()[\]{}]/u.test(pattern) || /[\\$]/u.test(replacement)) return undefined;
      operation = "replace";
      break;
    }
    case "split": {
      // Java split() takes a regular expression and drops trailing empty parts.
      const separator = literalText(argumentsNodes[0]);
      if (argumentsNodes.length !== 1 || separator === null || separator === "") return undefined;
      if (/[\\^$.|?*+()[\]{}]/u.test(separator)) return undefined;
      addDiagnostic(
        context,
        "SX_SPLIT_TRAILING_EMPTY",
        "warning",
        "Java split() drops trailing empty parts; the proposed split() keeps them.",
        node.span,
      );
      operation = "split";
      break;
    }
    case "substring":
      if (argumentsNodes.length !== 1 && argumentsNodes.length !== 2) return undefined;
      operation = "substring";
      break;
    case "equalsIgnoreCase": {
      if (argumentsNodes.length !== 1) return undefined;
      const left = lowerExpression(targetNode, context);
      const right = lowerExpression(argumentsNodes[0]!, context);
      if (left === null || right === null) return null;
      return {
        kind: "binary",
        operator: "==",
        left: member("lower", [], left),
        right: member("lower", [], right),
      };
    }
    default:
      return undefined;
  }
  const target = lowerExpression(targetNode, context);
  if (target === null) return null;
  const lowered = lowerArguments(argumentsNodes, context);
  return lowered === null ? null : member(operation, lowered, target);
}

/** Groovy/Java string methods; `size`/`length` also measure lists, which are handled when proven. */
const STRING_METHODS = new Set([
  "capitalize",
  "endsWith",
  "equalsIgnoreCase",
  "length",
  "replace",
  "replaceAll",
  "size",
  "split",
  "startsWith",
  "substring",
  "toLowerCase",
  "toUpperCase",
  "tokenize",
  "trim",
]);

/** Java Math helpers without an accepted TeaseScript built-in. */
const MATH_HELPERS = new Map<string, { name: HelperName; arity: number }>([
  ["abs", { name: "abs", arity: 1 }],
  ["max", { name: "max", arity: 2 }],
  ["min", { name: "min", arity: 2 }],
]);

/** Java default values: null for object types, zero or false for primitives. */
const PRIMITIVE_DEFAULTS = new Map<string, number | boolean>([
  ["boolean", false],
  ["byte", 0],
  ["double", 0],
  ["float", 0],
  ["int", 0],
  ["long", 0],
  ["short", 0],
]);

/** Arrays whose writes keep their values as a list does (a boolean array rejects other values). */
const LIST_LIKE_ARRAY_TYPES = new Set(["boolean", "Boolean", "Object", "double", "Double"]);
/** Arrays that convert written values (numbers truncate or round, values become text); converted with a note. */
const CONVERTING_ARRAY_TYPES = new Set([
  "byte",
  "Byte",
  "float",
  "Float",
  "int",
  "Integer",
  "long",
  "Long",
  "short",
  "Short",
  "String",
]);

function lowerArrayExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const sizes = nodeArray(node.sizes);
  const items = nodeArray(node.items);
  if (sizes.length === 0) {
    const values = lowerArguments(items, context);
    return values === null ? null : { kind: "list", items: values };
  }
  if (sizes.length !== 1 || items.length > 0) {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_ARRAY",
      "Multi-dimensional Java arrays are not converted automatically.",
    );
  }
  const elementType = (text(node.elementType) ?? "").replace(/^java\.lang\./u, "");
  if (CONVERTING_ARRAY_TYPES.has(elementType)) {
    addDiagnostic(
      context,
      "SX_JAVA_ARRAY_CONVERSION",
      "warning",
      `A Java ${elementType}[] converted every written value to its element type (truncating or rounding numbers, turning values into text); this list keeps values as written.`,
      node.span,
    );
  } else if (!LIST_LIKE_ARRAY_TYPES.has(elementType)) {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_ARRAY_TYPE",
      `A Java ${elementType}[] converts every written value to its element type; a TeaseScript list keeps values as written. Use a list and convert values explicitly.`,
    );
  }
  const size = lowerExpression(sizes[0]!, context);
  if (size === null) return null;
  const defaultValue = PRIMITIVE_DEFAULTS.get(elementType) ?? null;
  return useHelper(context, "array", [size, { kind: "literal", value: defaultValue }]);
}

function isCurrentDateValue(node: AstNode, context: LowerContext): boolean {
  const name = variableName(node);
  return name === null ? isCurrentDate(node) : context.dateValues.has(name);
}

function isCurrentDate(node: AstNode): boolean {
  const call = callParts(node);
  const calendar =
    call !== null &&
    call.name === "getInstance" &&
    call.arguments.length === 0 &&
    variableName(node.object) === "Calendar";
  return calendar || isCurrentDateConstructor(node);
}

function noteSharedListWrite(list: AstNode | null, node: AstNode, context: LowerContext): void {
  const name = list === null ? null : variableName(list);
  if (name === null || !context.aliasedLists.has(name)) return;
  addDiagnostic(
    context,
    "SX_SHARED_LIST_WRITE",
    "warning",
    `Groovy shared the list in ${name} with another variable assigned from it, so this change affected both; in TeaseScript the variables hold separate copies (ADR 0014).`,
    node.span,
  );
}

function aliasedListVariables(body: AstNode, types: TypeEnvironment): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    const target = assigns ? variableName(node.left) : null;
    const source = assigns ? variableName(node.right) : null;
    if (target === null || source === null) return;
    if (onlyOf(types.variables.get(source) ?? UNKNOWN, LIST | NULL)) {
      names.add(target);
      names.add(source);
    }
  });
  return names;
}

function currentDateVariables(body: AstNode, types: TypeEnvironment): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const name = node.kind === "declaration" ? variableName(node.left) : null;
    const value = asNode(node.right);
    if (
      name !== null &&
      value !== null &&
      isCurrentDate(value) &&
      types.singleAssignment?.has(name)
    ) {
      names.add(name);
    }
  });
  return names;
}

function isCurrentDateConstructor(node: AstNode): boolean {
  const args = asNode(node.arguments);
  return (
    node.kind === "constructorCall" &&
    (node.type === "java.util.Date" || node.type === "Date") &&
    (args === null || nodeArray(args.items).length === 0)
  );
}

/** `Calendar.getInstance().get(Calendar.FIELD)` reads one field of the current local date and time. */
function calendarGetField(target: AstNode | null, args: AstNode[]): string | null {
  const instance = target === null ? null : callParts(target);
  // Only the default instance: an explicit time zone or locale has no datetime-property equivalent.
  if (
    instance === null ||
    instance.name !== "getInstance" ||
    instance.arguments.length !== 0 ||
    variableName(target?.object) !== "Calendar"
  ) {
    return null;
  }
  return args.length === 1 ? calendarConstant(args[0]!) : null;
}

function calendarConstant(node: AstNode): string | null {
  if (node.kind !== "property" || variableName(node.object) !== "Calendar") return null;
  return constantString(node.property);
}

/**
 * Maps a java.util.Calendar field to the accepted TeaseScript datetime properties. Java months count from 0 and
 * Java weekdays run Sunday=1..Saturday=7, while TeaseScript uses months 1..12 and ISO Monday=1..Sunday=7.
 */
function dateTimeField(
  field: string,
  dateTime: IrExpression,
  node: AstNode,
  context: LowerContext,
): IrExpression | null {
  const property = (name: string): IrExpression => ({ kind: "property", target: dateTime, name });
  const literal = (value: number): IrExpression => ({ kind: "literal", value });
  switch (field) {
    case "YEAR":
      return property("year");
    case "MONTH":
      return { kind: "binary", operator: "-", left: property("month"), right: literal(1) };
    case "DATE":
    case "DAY_OF_MONTH":
      return property("day");
    case "HOUR_OF_DAY":
      return property("hour");
    case "MINUTE":
      return property("minute");
    case "DAY_OF_WEEK":
      return {
        kind: "binary",
        operator: "+",
        left: { kind: "binary", operator: "%", left: property("weekdayNumber"), right: literal(7) },
        right: literal(1),
      };
    default:
      return unsupportedExpression(
        context,
        node,
        "SX_CALENDAR_FIELD",
        `java.util.Calendar field ${field} has no direct TeaseScript datetime property.`,
      );
  }
}

/** A reference to a closure function without calling it (and not to a same-named local variable). */
function isUncalledClosure(node: AstNode, context: LowerContext): boolean {
  const name = variableName(node);
  return name !== null && context.functions.has(name) && !context.shadowingReferences.has(node);
}

/**
 * Finds variable references that resolve to a block-local `def` variable sharing its name with a closure function,
 * following Groovy's lexical block and closure scopes.
 */
function collectShadowingReferences(
  body: AstNode,
  functions: ReadonlyMap<string, unknown>,
): Set<AstNode> {
  const references = new Set<AstNode>();
  const visit = (value: unknown, scopes: Set<string>[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, scopes);
      return;
    }
    if (!isAstNode(value)) return;
    const node = value;
    if (node.kind === "block" || node.kind === "closure" || node.kind === "for") {
      const scope = new Set<string>();
      if (node.kind === "closure") {
        for (const parameter of groovyParameters(node.parameters) ?? []) scope.add(parameter.name);
      }
      if (node.kind === "for" && typeof node.variable === "string") scope.add(node.variable);
      const inner = [...scopes, scope];
      const children = node.kind === "block" ? nodeArray(node.statements) : nodeChildren(node);
      for (const child of children) visit(child, inner);
      return;
    }
    if (node.kind === "declaration") {
      const name = variableName(node.left);
      const right = asNode(node.right);
      if (right !== null) visit(right, scopes);
      if (name !== null && functions.has(name) && right?.kind !== "closure")
        scopes.at(-1)?.add(name);
      return;
    }
    if (node.kind === "variable") {
      const name = variableName(node);
      if (name !== null && functions.has(name) && scopes.some((scope) => scope.has(name))) {
        references.add(node);
      }
      return;
    }
    for (const child of nodeChildren(node)) visit(child, scopes);
  };
  visit(body, []);
  return references;
}

function isKnownListExpression(node: AstNode, context: LowerContext): boolean {
  const type = inferType(node, context.types);
  return onlyOf(type, LIST | NULL) && (type & LIST) !== 0;
}

function lowerMethodCallExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const call = callParts(node);
  if (call === null) {
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_OR_OBJECT_CALL",
      "Dynamic Groovy method names are not lowered by the first slice.",
    );
  }
  if (!call.inherited)
    return lowerObjectMethodCallExpression(node, call.name, call.arguments, context);
  // A parameter or local of the current function shadows a function of the same name; calling it calls the
  // closure value it holds.
  if (context.helperMainParameter === null && isVisibleLocal(call.name, node, context)) {
    const args = lowerArguments(call.arguments, context);
    return args === null ? null : actionCall({ kind: "variable", name: call.name }, args, context);
  }
  const helperInfo = context.helperFunctions.get(call.name);
  if (helperInfo !== undefined) {
    let argumentNodes = call.arguments;
    if (helperInfo.stripsMain) {
      if (
        context.helperMainParameter === null ||
        variableName(argumentNodes[0]) !== context.helperMainParameter
      ) {
        return unsupportedExpression(
          context,
          node,
          "SX_HELPER_MAIN_ARGUMENT",
          `Helper call ${call.name}() does not pass the expected legacy main object.`,
        );
      }
      argumentNodes = argumentNodes.slice(1);
    }
    if (argumentNodes.length < helperInfo.minArgs || argumentNodes.length > helperInfo.maxArgs) {
      return unsupportedExpression(
        context,
        node,
        "SX_FUNCTION_ARITY",
        `Call to ${call.name} has ${argumentNodes.length} authored arguments; expected ${helperInfo.minArgs}..${helperInfo.maxArgs}.`,
      );
    }
    const args = lowerArguments(argumentNodes, context);
    return args === null
      ? null
      : { kind: "call", name: call.name, positional: args, named: {}, local: true };
  }
  if (
    context.packageFunctions.has(call.name) &&
    !context.functions.has(call.name) &&
    context.helperMainParameter === null
  ) {
    // Defined elsewhere in the package (for example an injected mixin method); arity is checked by the compiler.
    const args = lowerArguments(call.arguments, context);
    return args === null
      ? null
      : { kind: "call", name: call.name, positional: args, named: {}, local: true };
  }
  if (
    !context.functions.has(call.name) &&
    !context.packageFunctions.has(call.name) &&
    context.types.variables.has(call.name) &&
    context.helperMainParameter === null
  ) {
    // Groovy `name(...)` on a variable calls the closure it holds; closure values are action IDs here.
    const args = lowerArguments(call.arguments, context);
    return args === null ? null : actionCall({ kind: "variable", name: call.name }, args, context);
  }
  const functionInfo = context.functions.get(call.name);
  if (functionInfo !== undefined) {
    if (
      call.arguments.length < functionInfo.minArgs ||
      call.arguments.length > functionInfo.maxArgs
    ) {
      return unsupportedExpression(
        context,
        node,
        "SX_FUNCTION_ARITY",
        `Call to ${call.name} has ${call.arguments.length} arguments; expected ${functionInfo.minArgs}..${functionInfo.maxArgs}.`,
      );
    }
    const args = lowerArguments(call.arguments, context);
    return args === null
      ? null
      : { kind: "call", name: call.name, positional: args, named: {}, local: true };
  }
  if (
    context.helperMainParameter !== null &&
    variableName(node.object) !== context.helperMainParameter
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_HELPER_UNQUALIFIED_CALL",
      `Unqualified Groovy helper call ${call.name}() is not assumed to be a SexScript host API.`,
    );
  }
  if (DIRECT_STORAGE_LOADS.has(call.name)) {
    if (call.arguments.length !== 1) {
      return unsupportedExpression(
        context,
        node,
        "SX_STORAGE_LOAD_ARITY",
        `${call.name}() must have exactly one key argument.`,
      );
    }
    const key = lowerExpression(call.arguments[0]!, context);
    return key === null ? null : { kind: "load", key };
  }
  if (call.name === "loadMap") {
    return unsupportedExpression(
      context,
      node,
      "SX_STORAGE_MAP_SEMANTICS",
      "Legacy loadMap() filters the loaded value to Map-or-null; automatic object/map migration is not proven safe yet.",
    );
  }
  if (call.name === "loadFirstTrue") {
    const keys = lowerArguments(call.arguments, context);
    if (keys === null) return null;
    return useHelper(context, "loadFirstTrue", [{ kind: "list", items: keys }]);
  }

  // getSelectedValue lowers its own arguments: its option list must stay a literal list.
  if (call.name === "getSelectedValue") return lowerSelectedValue(node, call.arguments, context);
  const args = lowerArguments(call.arguments, context);
  if (args === null) return null;

  switch (call.name) {
    case "getRandom":
      if (args.length !== 1)
        return unsupportedExpression(
          context,
          node,
          "SX_RANDOM_ARITY",
          "getRandom() must have one argument.",
        );
      // Only a positive integer bound is certain to give randomInteger() a non-empty range.
      if (
        args[0]!.kind === "literal" &&
        typeof args[0]!.value === "number" &&
        Number.isInteger(args[0]!.value) &&
        args[0]!.value > 0
      ) {
        return {
          kind: "call",
          name: "randomInteger",
          positional: [
            { kind: "range", from: { kind: "literal", value: 0 }, to: args[0]!, inclusive: false },
          ],
          named: {},
        };
      }
      return useHelper(context, "random", args);
    case "showPopup": {
      // TeaseScript popups return nothing; the legacy result was the seconds until the player closed it.
      const root = context.statementRoot;
      if (args.length !== 1 || root === null || !isHoistable(root, node, context)) {
        return unsupportedExpression(
          context,
          node,
          "SX_POPUP_POSITION",
          "The popup's waiting time is used inside a larger expression that cannot run around the popup; assign showPopup() to a variable first.",
        );
      }
      context.popupTimers += 1;
      const start = context.popupTimers === 1 ? "popupStart" : `popupStart${context.popupTimers}`;
      const seconds: IrExpression = { kind: "call", name: "getSeconds", positional: [], named: {} };
      addDiagnostic(
        context,
        "SX_POPUP_ELAPSED",
        "warning",
        "showPopup() returned the seconds until the player closed the popup; TeaseScript popups return nothing, so the time is measured with getSeconds(), in whole seconds.",
        node.span,
      );
      // Legacy timing started once the message was computed.
      let message = args[0]!;
      if (!isPure(call.arguments[0]!, context)) {
        const name = start.replace("popupStart", "popupMessage");
        context.prelude.push({ kind: "let", name, value: message, span: node.span });
        message = { kind: "variable", name };
      }
      context.prelude.push(
        { kind: "let", name: start, value: seconds, span: node.span },
        { kind: "showPopup", message, span: node.span },
      );
      return {
        kind: "binary",
        operator: "-",
        left: seconds,
        right: { kind: "variable", name: start },
      };
    }
    case "getTime":
      return args.length === 0
        ? { kind: "call", name: "getSeconds", positional: [], named: {} }
        : unsupportedExpression(
            context,
            node,
            "SX_TIME_ARITY",
            "getTime() must have no arguments.",
          );
    case "getBoolean": {
      if (args.length !== 1 && args.length !== 3) {
        return unsupportedExpression(
          context,
          node,
          "SX_BOOLEAN_ARITY",
          "getBoolean() must have one or three arguments.",
        );
      }
      // Legacy getBoolean shows its text like show() and then two buttons; the first button means true.
      if (!pushPrompt(context, node, call.arguments[0]!, args[0]!)) return null;
      const yes = args[1] ?? { kind: "literal", value: "Yes" };
      const no = args[2] ?? { kind: "literal", value: "No" };
      return {
        kind: "binary",
        operator: "==",
        left: { kind: "choice", options: [yes, no], labels: ["yes", "no"] },
        right: { kind: "literal", value: "yes" },
      };
    }
    case "getBooleans":
      return args.length === 3
        ? {
            kind: "call",
            name: "askBooleans",
            positional: [],
            named: { message: args[0]!, texts: args[1]!, defaults: args[2]! },
          }
        : unsupportedExpression(
            context,
            node,
            "SX_BOOLEANS_ARITY",
            "getBooleans() must have exactly three arguments.",
          );
    case "showButton":
      return args.length === 1 || args.length === 2
        ? { kind: "call", name: "showButton", positional: args, named: {} }
        : unsupportedExpression(
            context,
            node,
            "SX_BUTTON_ARITY",
            "showButton() must have one or two arguments.",
          );
    case "useUrl":
      return args.length === 1
        ? { kind: "call", name: "openUrl", positional: args, named: {} }
        : unsupportedExpression(context, node, "SX_URL_ARITY", "useUrl() must have one argument.");
    case "getString":
    case "getInteger":
    case "getFloat":
      return lowerSingleInput(node, call.name, call.arguments, args, context);
    default:
      if (!SEXSCRIPT_API_METHODS.has(call.name)) {
        return unsupportedExpression(
          context,
          node,
          "SX_UNDEFINED_FUNCTION",
          `${call.name}() is not defined in this script, its package helpers, or the SexScript API; SexScript failed here at runtime.`,
        );
      }
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_SEXSCRIPT_EXPRESSION",
        `Unsupported SexScript expression call: ${call.name}`,
      );
  }
}

/**
 * Legacy single-field input shows `message` in its dialog and pre-fills `defaultValue`. TeaseScript shows the
 * question with `say` and then asks with a compact input; it has no single-field prefill.
 */
function lowerSingleInput(
  node: AstNode,
  name: string,
  argumentNodes: AstNode[],
  args: IrExpression[],
  context: LowerContext,
): IrExpression | null {
  if (args.length < 1 || args.length > 2) {
    return unsupportedExpression(
      context,
      node,
      "SX_INPUT_ARITY",
      `${name}() must have a message and an optional default value.`,
    );
  }
  const defaultNode = argumentNodes[1];
  if (defaultNode !== undefined && !isPure(defaultNode, context)) {
    return unsupportedExpression(
      context,
      node,
      "SX_INPUT_PREFILL_EFFECT",
      `${name}() computes its pre-filled value with side effects; TeaseScript input has no prefill, so keep that computation explicitly before the question.`,
    );
  }
  if (defaultNode !== undefined && !isEmptyDefault(defaultNode)) {
    addDiagnostic(
      context,
      "SX_INPUT_PREFILL",
      "warning",
      `${name}() pre-filled its field with a default value; TeaseScript single-field input has no prefill, so the player must type it.`,
      node.span,
    );
  }
  if (name === "getInteger") {
    // Accepted V30 integer input; compact syntax exists only for text and number input. A null legacy
    // message kept the current text, so the field gets no message of its own.
    const message = isNullConstant(argumentNodes[0])
      ? { kind: "literal" as const, value: "" }
      : args[0]!;
    return { kind: "call", name: "askInteger", positional: [message], named: {} };
  }
  if (!pushPrompt(context, node, argumentNodes[0]!, args[0]!)) return null;
  return { kind: "input", input: name === "getString" ? "askText" : "askNumber" };
}

function isEmptyDefault(node: AstNode): boolean {
  return node.kind === "constant" && (node.value === null || node.value === "");
}

/**
 * Legacy input text replaces the shown text like show(); `null` keeps the current text. The prompt becomes a
 * `say` before the statement, which is only equivalent when the input could be evaluated first; otherwise this
 * reports the input and returns false.
 */
function pushPrompt(
  context: LowerContext,
  inputNode: AstNode,
  messageNode: AstNode,
  message: IrExpression,
): boolean {
  if (isNullConstant(messageNode)) return true;
  const root = context.statementRoot;
  // Groovy evaluates all arguments before showing the message, so other arguments must not have effects.
  const otherArguments = (callParts(inputNode)?.arguments ?? []).filter(
    (argument) => argument !== messageNode,
  );
  const ordered =
    root !== null &&
    isHoistable(root, inputNode, context, messageNode) &&
    otherArguments.every((argument) => isPure(argument, context));
  if (!ordered) {
    addDiagnostic(
      context,
      "SX_PROMPT_POSITION",
      "error",
      "This input's question cannot be shown at the right moment: the input is guarded by && / || / ?:, follows side effects in the same statement, or has arguments with side effects. Split the statement so the input comes first.",
      inputNode.span,
    );
    return false;
  }
  const say: IrStatement = { kind: "say", value: message, span: inputNode.span };
  if (onlyOf(inferType(messageNode, context.types), STRING)) {
    context.prelude.push(say);
  } else if (isRepeatableExpression(messageNode)) {
    // A null legacy message kept the current text instead of showing "null".
    context.prelude.push({
      kind: "if",
      condition: {
        kind: "binary",
        operator: "!=",
        left: message,
        right: { kind: "literal", value: null },
      },
      then: [say],
      else: [],
      span: inputNode.span,
    });
  } else {
    addDiagnostic(
      context,
      "SX_PROMPT_NULLABLE",
      "warning",
      "This input message may be null at runtime; legacy then kept the current text, while say would show null.",
      inputNode.span,
    );
    context.prelude.push(say);
  }
  return true;
}

/** Legacy getSelectedValue() returns the zero-based index, which numeric `choose` labels reproduce. */
function lowerSelectedValue(
  node: AstNode,
  args: AstNode[],
  context: LowerContext,
): IrExpression | null {
  if (args.length !== 2) {
    return unsupportedExpression(
      context,
      node,
      "SX_CHOICE_ARITY",
      "getSelectedValue() must have exactly two arguments.",
    );
  }
  const message = lowerExpression(args[0]!, context);
  if (message === null) return null;
  const optionsNode = args[1]!;
  if (optionsNode.kind !== "list") {
    if (context.proposals.has("choose-lists")) {
      const proposed = proposedSelectedValue(node, args[0]!, message, optionsNode, context);
      if (proposed !== undefined) return proposed;
    }
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_CHOICE_OPTIONS",
      "getSelectedValue() options come from a runtime list; TeaseScript choose needs its options written out in the source.",
    );
  }
  const options: IrExpression[] = [];
  for (const item of nodeArray(optionsNode.items)) {
    const option = lowerExpression(item, context);
    if (option === null) return null;
    options.push(option);
  }
  if (options.length === 0) {
    return unsupportedExpression(
      context,
      node,
      "SX_EMPTY_CHOICE",
      "getSelectedValue() has no choices.",
    );
  }
  if (!pushPrompt(context, node, args[0]!, message)) return null;
  return { kind: "choice", options };
}

/**
 * getSelectedValue() over a runtime list as a proposed `choose` (choose-lists): written options before one runtime
 * list keep their zero-based index as numeric label and the list's elements get the following ones, so the result
 * stays the legacy index. A `collect` that builds the list becomes a loop before the statement. Returns undefined
 * when the options do not have that shape.
 */
function proposedSelectedValue(
  node: AstNode,
  messageNode: AstNode,
  message: IrExpression,
  optionsNode: AstNode,
  context: LowerContext,
): IrExpression | null | undefined {
  const pieces = listPlusOperands(optionsNode);
  const listNode = pieces.at(-1)!;
  const written = pieces.slice(0, -1);
  if (listNode.kind === "list" || written.some((piece) => piece.kind !== "list")) return undefined;
  const writtenItems = written.flatMap((piece) => nodeArray(piece.items));
  let loop: IrStatement[] = [];
  let list: IrExpression;
  if (callParts(listNode)?.name === "collect") {
    const root = context.statementRoot;
    if (root === null || !isHoistable(root, node, context, listNode)) return undefined;
    const name = freshName("menuTexts", context);
    const lowered = lowerCollectionAssignment(true, name, listNode, node.span, context);
    if (lowered === null) return undefined;
    loop = lowered;
    list = { kind: "variable", name };
  } else {
    if (!isKnownListExpression(listNode, context)) return undefined;
    const lowered = lowerExpression(listNode, context);
    if (lowered === null) return null;
    list = lowered;
  }
  const options: IrListChoiceOption[] = [];
  for (const [index, item] of writtenItems.entries()) {
    const text = lowerExpression(item, context);
    if (text === null) return null;
    options.push({ kind: "option", label: index, text });
  }
  context.prelude.push(...loop);
  if (!pushPrompt(context, node, messageNode, message)) return null;
  const first: IrExpression = { kind: "literal", value: writtenItems.length };
  options.push({
    kind: "list",
    list: useHelper(context, "menuOptions", [list, first]),
    records: true,
  });
  return { kind: "listChoice", options };
}

/** The operands of a Groovy `a + b + c` chain, or the node itself. */
function listPlusOperands(node: AstNode): AstNode[] {
  const left = asNode(node.left);
  const right = asNode(node.right);
  if (node.kind === "binary" && node.operator === "+" && left !== null && right !== null) {
    return [...listPlusOperands(left), right];
  }
  return [node];
}

function lowerArguments(args: AstNode[], context: LowerContext): IrExpression[] | null {
  const result: IrExpression[] = [];
  for (const arg of args) {
    const lowered = lowerExpression(arg, context);
    if (lowered === null) return null;
    result.push(lowered);
  }
  return result;
}

function oneArgumentStatement(
  args: AstNode[],
  context: LowerContext,
  node: AstNode,
  build: (value: IrExpression) => IrStatement,
): IrStatement[] {
  if (args.length !== 1)
    return [unsupportedStatement(context, node, "SX_CALL_ARITY", "Expected one argument.")];
  const value = lowerExpression(args[0]!, context);
  return value === null
    ? [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_ARGUMENT",
          "Argument could not be migrated.",
        ),
      ]
    : [build(value)];
}

/**
 * `say` text is message markup. Legacy emphasis such as `*grin*` reasonably becomes formatting, but block
 * markers at a line start and backslash escapes were plain text in SexScript and likely change the message.
 */
function noteUnintendedMarkup(node: AstNode | undefined, context: LowerContext): void {
  if (node === undefined) return;
  const texts: string[] = [];
  walkAst(node, (child) => {
    if (child.kind === "constant" && typeof child.value === "string") texts.push(child.value);
    if (child.kind === "gstring" && Array.isArray(child.strings)) {
      for (const part of child.strings) if (typeof part === "string") texts.push(part);
    }
  });
  const risky = texts.some(
    (text) =>
      /(^|\n)(#{1,3} |> |- |[1-9][0-9]*\. )/u.test(text) || /\\[\\*~`[\]()#>\-.:]/u.test(text),
  );
  if (risky) {
    addDiagnostic(
      context,
      "SX_SAY_MARKUP",
      "warning",
      "This legacy plain text contains a line-start list/heading/quote marker or a backslash escape that TeaseScript say renders as message markup; use escapeMarkup() if it must stay literal.",
      node.span,
    );
  }
}

function extractMetadata(args: AstNode[], context: LowerContext, span: SourceSpan | null): void {
  if (args.length !== 8) {
    addDiagnostic(
      context,
      "SX_METADATA_DYNAMIC",
      "warning",
      "setInfos() metadata could not be extracted statically.",
      span,
    );
    return;
  }
  const values = args.map(constantValue);
  const tagsNode = args[7];
  const tagNames = tagsNode?.kind === "list" ? nodeArray(tagsNode.items).map(constantString) : [];
  const tags = tagNames.filter((tag) => tag !== null);
  const tagsValid = tagsNode?.kind === "list" && tags.length === tagNames.length;
  if (values.slice(0, 7).some((value) => value === undefined) || !tagsValid) {
    addDiagnostic(
      context,
      "SX_METADATA_DYNAMIC",
      "warning",
      "setInfos() metadata could not be extracted statically.",
      span,
    );
    return;
  }
  context.metadata = {
    apiVersion: numberOrNull(values[0]),
    title: stringOrNull(values[1]),
    summary: stringOrNull(values[2]),
    author: stringOrNull(values[3]),
    status: stringOrNull(values[4]),
    color: numberOrNull(values[5]),
    language: stringOrNull(values[6]),
    tags,
  };
}

function callParts(
  node: AstNode,
): { name: string; inherited: boolean; arguments: AstNode[] } | null {
  if (node.kind !== "methodCall") return null;
  const name = constantString(node.method);
  if (name === null) return null;
  const objectName = variableName(node.object);
  const inherited = node.implicitThis === true || objectName === "main";
  const argsNode = asNode(node.arguments);
  return { name, inherited, arguments: argsNode === null ? [] : nodeArray(argsNode.items) };
}

interface LegacyHelperBindings {
  classLoaders: Set<string>;
  helperClasses: Map<string, string>;
}

function collectLegacyHelperBindings(body: AstNode): LegacyHelperBindings {
  const classLoaders = new Set<string>();
  walkAst(body, (node) => {
    if (node.kind !== "declaration") return;
    const name = variableName(node.left);
    const value = asNode(node.right);
    if (name !== null && value !== null && isGroovyClassLoaderConstructor(value))
      classLoaders.add(name);
  });

  const helperClasses = new Map<string, string>();
  walkAst(body, (node) => {
    if (node.kind !== "declaration") return;
    const name = variableName(node.left);
    const value = asNode(node.right);
    if (name === null || value === null || !isLegacyLoadClassCall(value, classLoaders)) return;
    const argsNode = asNode(value.arguments);
    const className = argsNode === null ? null : constantString(nodeArray(argsNode.items)[0]);
    if (className !== null) helperClasses.set(name, className);
  });
  return { classLoaders, helperClasses };
}

function isGroovyClassLoaderConstructor(node: AstNode): boolean {
  return node.kind === "constructorCall" && node.type === "groovy.lang.GroovyClassLoader";
}

function isLegacyLoadClassCall(node: AstNode, classLoaders: Set<string>): boolean {
  if (node.kind !== "methodCall" || constantString(node.method) !== "loadClass") return false;
  const receiver = variableName(node.object);
  return receiver !== null && classLoaders.has(receiver);
}

interface MixinShape {
  parameter: string;
  methods: Array<{ name: string; closure: AstNode }>;
  loadStatements: AstNode[];
  setup: AstNode | null;
}

/**
 * A runtime-loaded mixin module is a file whose only statement is a one-parameter closure, evaluated by the
 * package's loader with the script object as argument. `object.metaClass.name = { ... }` (or the call form
 * `object.metaClass.name { ... }`) injects a method; other statements run at load time; a returned closure is
 * a setup callback that the loader runs later.
 */
function mixinShape(body: AstNode): MixinShape | null {
  const statements = nodeArray(body.statements).filter((statement) => statement.kind !== "empty");
  const only = statements.length === 1 ? statements[0] : undefined;
  const closure = only?.kind === "expressionStatement" ? asNode(only.expression) : null;
  if (closure?.kind !== "closure" || closure.parameterSpecified !== true) return null;
  const parameters = groovyParameters(closure.parameters);
  const closureBody = asNode(closure.body);
  if (parameters?.length !== 1 || closureBody?.kind !== "block") return null;
  const parameter = parameters[0]!.name;
  const shape: MixinShape = { parameter, methods: [], loadStatements: [], setup: null };
  const inner = nodeArray(closureBody.statements);
  // An earlier return makes the result depend on control flow; only a module that always returns nothing has a
  // fixed result then.
  const earlyReturns = inner.slice(0, -1).flatMap((statement) => closureReturns(statement));
  const final = inner.at(-1);
  const finalValue = asNode(final?.kind === "return" ? final.value : null);
  const returnsNothing = (value: AstNode | null): boolean =>
    value === null || isNullConstant(value);
  if (
    earlyReturns.length > 0 &&
    (earlyReturns.some(({ value }) => !returnsNothing(value)) ||
      final?.kind !== "return" ||
      !returnsNothing(finalValue))
  ) {
    return null;
  }
  const lastMethod = inner.length === 0 ? null : injectedMethod(inner.at(-1)!, parameter);
  inner.forEach((statement, index) => {
    const method = injectedMethod(statement, parameter);
    if (method !== null) {
      shape.methods.push(method);
      return;
    }
    const value = asNode(statement.kind === "return" ? statement.value : statement.expression);
    if (index === inner.length - 1 && (statement.kind === "return" || value?.kind === "closure")) {
      if (value?.kind === "closure") shape.setup = value;
      else if (value !== null && !isNullConstant(value)) shape.loadStatements.push(statement);
      return;
    }
    shape.loadStatements.push(statement);
  });
  // A final `object.metaClass.name = { }` returns the assigned closure, which the loader runs as setup.
  const last = inner.at(-1);
  const assignsLast =
    last?.kind === "expressionStatement" && asNode(last.expression)?.kind === "binary";
  if (lastMethod !== null && assignsLast) {
    shape.setup = {
      kind: "closure",
      span: last.span,
      parameters: [],
      parameterSpecified: true,
      body: {
        kind: "block",
        span: last.span,
        statements: [callStatement(lastMethod.name, last.span)],
      },
    };
  }
  return shape;
}

function injectedMethod(
  statement: AstNode,
  parameter: string,
): { name: string; closure: AstNode } | null {
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  if (expression === null) return null;
  const isMetaClass = (node: unknown): boolean =>
    isAstNode(node) &&
    node.kind === "property" &&
    variableName(node.object) === parameter &&
    constantString(node.property) === "metaClass";
  if (expression.kind === "methodCall" && isMetaClass(expression.object)) {
    const name = constantString(expression.method);
    const args = nodeArray(asNode(expression.arguments)?.items);
    return name !== null && args.length === 1 && args[0]!.kind === "closure"
      ? { name, closure: args[0]! }
      : null;
  }
  const left = asNode(expression.left);
  const right = asNode(expression.right);
  if (expression.kind === "binary" && expression.operator === "=" && left?.kind === "property") {
    const name = constantString(left.property);
    return name !== null && isMetaClass(left.object) && right?.kind === "closure"
      ? { name, closure: right }
      : null;
  }
  return null;
}

/**
 * A module's loader lists `scripts/<directory>` and keeps names ending in `.groovy` (case-sensitive); files elsewhere
 * get no directory, so no loader selects them.
 */
function moduleNames(sourceName: string): { directory: string; name: string } {
  const parts = sourceName.split(/[\\/]/u);
  const file = parts.at(-1) ?? sourceName;
  const name = file.replace(/\.groovy$/u, "");
  const loadable = file.endsWith(".groovy") && parts.at(-3) === "scripts";
  return { directory: loadable ? (parts.at(-2) ?? "") : "", name };
}

function capitalized(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * Functions every package file may call: methods injected by mixin modules and the members of an anonymous-object
 * script, which mixin code reaches through the object receiver.
 */
export function packageFunctionNames(files: readonly ParsedGroovyFile[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const name of describeMixinModule(file)?.functions ?? []) names.add(name);
    if (file.root?.kind !== "scriptBody") continue;
    for (const objectClass of nodeArray(file.root.classes)) {
      for (const field of nodeArray(objectClass.fields)) {
        if (asNode(field.initialExpression)?.kind === "closure" && typeof field.name === "string") {
          names.add(field.name);
        }
      }
      for (const method of nodeArray(objectClass.methods)) {
        if (typeof method.name === "string") names.add(method.name);
      }
    }
  }
  return names;
}

/** Adds package-global types for names the file does not assign itself; shared names take the union. */
function withGlobalTypes(
  environment: TypeEnvironment,
  globals: ReadonlyMap<string, number> | undefined,
): TypeEnvironment {
  if (globals === undefined || globals.size === 0) return environment;
  const variables = new Map(environment.variables);
  for (const [name, type] of globals) variables.set(name, (variables.get(name) ?? 0) | type);
  return { ...environment, variables };
}

/** Value types of anonymous-object fields, which mixin modules reach through the object receiver. */
export function packageGlobalTypes(files: readonly ParsedGroovyFile[]): Map<string, number> {
  const types = new Map<string, number>();
  for (const file of files) {
    if (file.root?.kind !== "scriptBody") continue;
    for (const objectClass of nodeArray(file.root.classes)) {
      const statements = nodeArray(objectClass.fields).map((field) => ({
        kind: "expressionStatement",
        span: field.span,
        expression: {
          kind: "declaration",
          span: field.span,
          left: syntheticVariable(String(field.name), field.span),
          right: asNode(field.initialExpression) ?? { kind: "constant", span: null, value: null },
        },
      }));
      const methods = nodeArray(objectClass.methods)
        .map((method) => asNode(method.body))
        .filter((body) => body !== null);
      const environment = inferVariableTypes({
        kind: "block",
        span: null,
        statements: [...statements, ...methods],
      });
      for (const field of nodeArray(objectClass.fields)) {
        const name = String(field.name);
        const type = environment.variables.get(name);
        if (type !== undefined && asNode(field.initialExpression)?.kind !== "closure")
          types.set(name, type);
      }
    }
  }
  return types;
}

/**
 * Names assigned exactly once across all package files (declarations and object fields included), such as
 * constants shared by mixin modules.
 */
export function packageStableNames(files: readonly ParsedGroovyFile[]): Set<string> {
  const counts = new Map<string, number>();
  const count = (name: string | null): void => {
    if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const file of files) {
    walkAst(file.root, (node) => {
      const operator = typeof node.operator === "string" ? node.operator : "";
      const assigns = operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(operator);
      if (node.kind === "declaration" || (node.kind === "binary" && assigns))
        count(variableName(node.left));
      if (node.kind === "postfix" || node.kind === "prefix") count(variableName(node.value));
      if (node.kind === "field") count(typeof node.name === "string" ? node.name : null);
    });
  }
  return new Set([...counts].filter(([, total]) => total === 1).map(([name]) => name));
}

/** Describes a runtime-loaded mixin module without lowering it; null for ordinary scripts. */
export function describeMixinModule(file: ParsedGroovyFile): MixinModuleInfo | null {
  const body = file.root?.kind === "scriptBody" ? asNode(file.root.body) : null;
  const shape = body === null ? null : mixinShape(body);
  if (shape === null) return null;
  const { directory, name } = moduleNames(file.sourceName);
  const loadFunction = `load${capitalized(name)}Module`;
  const setupFunction = shape.setup === null ? null : `setup${capitalized(name)}Module`;
  const hoisted = shape.loadStatements.flatMap((statement) => {
    const declaration =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const declared = declaration?.kind === "declaration" ? variableName(declaration.left) : null;
    return declared !== null && asNode(declaration?.right)?.kind === "closure" ? [declared] : [];
  });
  return {
    sourceName: file.sourceName,
    directory,
    name,
    loadFunction,
    setupFunction,
    injected: shape.methods.map((method) => method.name),
    functions: [
      ...shape.methods.map((method) => method.name),
      ...hoisted,
      loadFunction,
      ...(setupFunction === null ? [] : [setupFunction]),
    ],
  };
}

/**
 * Flattens a mixin module into an ordinary script body of declarations: injected methods and module-level
 * closures become functions, module-level variables (which injected methods capture) become globals that the
 * load function assigns, and the object receiver is removed (`object.x(...)` becomes `x(...)`).
 */
function desugarMixinModule(
  body: AstNode,
  sourceName: string,
): { body: AstNode; info: MixinModuleInfo } | null {
  const shape = mixinShape(body);
  const info =
    shape === null
      ? null
      : describeMixinModule({
          formatVersion: 1,
          sourceName,
          groovyVersion: "",
          mode: "script-body",
          root: { kind: "scriptBody", span: null, body },
          diagnostics: [],
        });
  if (shape === null || info === null) return null;
  // A module variable that shares its name with an object member reached as `object.name` keeps its own name
  // apart, since removing the receiver would otherwise make both the same variable.
  const moduleVariables = new Set(
    shape.loadStatements.flatMap((statement) => {
      const expression =
        statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
      const name = expression?.kind === "declaration" ? variableName(expression.left) : null;
      return name === null ? [] : [name];
    }),
  );
  const receiverMembers = new Set<string>();
  walkAst(body, (node) => {
    const name = node.kind === "property" ? constantString(node.property) : null;
    if (name !== null && variableName(node.object) === shape.parameter) receiverMembers.add(name);
  });
  const renamed = new Map(
    [...moduleVariables]
      .filter((name) => receiverMembers.has(name))
      .map((name) => [name, `${name}In${capitalized(info.name)}`]),
  );
  const strip = (node: AstNode): AstNode =>
    stripReceiver(renamed.size === 0 ? node : renameVariables(node, renamed), shape.parameter);
  const declaration = (name: string, right: AstNode, span: SourceSpan | null): AstNode => ({
    kind: "expressionStatement",
    span,
    expression: { kind: "declaration", span, left: syntheticVariable(name, span), right },
  });
  const functionClosure = (statements: AstNode[], span: SourceSpan | null): AstNode => ({
    kind: "closure",
    span,
    parameters: [],
    parameterSpecified: true,
    body: { kind: "block", span, statements },
  });

  const globals: AstNode[] = [];
  const loadBody: AstNode[] = [];
  // Injected methods become functions that exist from the start; Groovy installed them in order.
  const installedAt = new Map(
    shape.methods.map((method) => [method.name, method.closure.span?.line ?? 0]),
  );
  for (const original of shape.loadStatements) {
    const early = new Set<string>();
    walkAst(original, (node) => {
      const call = node.kind === "methodCall" ? callParts(node) : null;
      const line = call === null ? undefined : installedAt.get(call.name);
      if (call !== null && line !== undefined && (original.span?.line ?? 0) < line)
        early.add(call.name);
    });
    if (early.size > 0) {
      loadBody.push({
        kind: "importerNote",
        span: original.span,
        code: "SX_MODULE_EARLY_CALL",
        message: `This load-time code calls ${[...early].join(", ")} before the module installed ${early.size === 1 ? "it" : "them"}, which failed in Groovy; the converted function exists from the start.`,
      });
    }
  }
  for (const statement of shape.loadStatements.map(strip)) {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const name = expression?.kind === "declaration" ? variableName(expression.left) : null;
    const right = asNode(expression?.right);
    if (name !== null && right?.kind === "closure") {
      globals.push(statement);
    } else if (name !== null && right !== null) {
      globals.push(
        declaration(
          name,
          {
            kind: "unsupportedExpression",
            span: null,
            groovyType: "org.codehaus.groovy.ast.expr.EmptyExpression",
          },
          statement.span,
        ),
      );
      if (!isEmptyGroovyExpression(right)) {
        loadBody.push({
          kind: "expressionStatement",
          span: statement.span,
          expression: {
            kind: "binary",
            span: statement.span,
            operator: "=",
            left: syntheticVariable(name, statement.span),
            right,
          },
        });
      }
    } else {
      loadBody.push(statement);
    }
  }
  const members = shape.methods.map((method) =>
    declaration(method.name, strip(method.closure), method.closure.span),
  );
  members.push(declaration(info.loadFunction, functionClosure(loadBody, body.span), body.span));
  if (shape.setup !== null && info.setupFunction !== null) {
    // The setup closure keeps its parameters; the loader calls it without arguments.
    members.push(declaration(info.setupFunction, strip(shape.setup), shape.setup.span));
  }
  const statements = [...globals, ...members].sort(
    (left, right) => (left.span?.line ?? 0) - (right.span?.line ?? 0),
  );
  return { body: { ...body, statements }, info };
}

/** Renames plain variable references; member accesses such as `object.name` keep their property names. */
function renameVariables(node: AstNode, names: ReadonlyMap<string, string>): AstNode {
  const name = variableName(node);
  if (name !== null) return names.has(name) ? { ...node, name: names.get(name)! } : node;
  const result: AstNode = { ...node };
  for (const [key, child] of Object.entries(node)) {
    if (key === "span") continue;
    if (isAstNode(child)) result[key] = renameVariables(child, names);
    else if (Array.isArray(child)) {
      result[key] = child.map((item) => {
        if (isAstNode(item)) return renameVariables(item, names);
        // Closure parameters are plain records with a name.
        if (key === "parameters" && isRecord(item) && typeof item.name === "string") {
          const renamedParameter = names.get(item.name);
          if (renamedParameter !== undefined) return { ...item, name: renamedParameter };
        }
        return item;
      });
    }
  }
  return result;
}

function syntheticVariable(name: string, span: SourceSpan | null): AstNode {
  return { kind: "variable", span, name, type: "java.lang.Object" };
}

/** Replaces `object.x(...)` with `x(...)` and `object.x` with `x`; a bare `object` becomes `this`. */
function stripReceiver(node: AstNode, parameter: string): AstNode {
  if (node.kind === "variable" && variableName(node) === parameter)
    return { ...node, name: "this" };
  const propertyName = node.kind === "property" ? constantString(node.property) : null;
  if (propertyName !== null && variableName(node.object) === parameter) {
    return syntheticVariable(propertyName, node.span);
  }
  const result: AstNode = { ...node };
  if (node.kind === "methodCall" && variableName(node.object) === parameter) {
    result.object = syntheticVariable("this", node.span);
    result.implicitThis = true;
  }
  for (const [key, child] of Object.entries(result)) {
    if (key === "span" || key === "object") continue;
    if (isAstNode(child)) result[key] = stripReceiver(child, parameter);
    else if (Array.isArray(child)) {
      result[key] = child.map((item) => (isAstNode(item) ? stripReceiver(item, parameter) : item));
    }
  }
  const object = asNode(result.object);
  if (object !== null && result.implicitThis !== true)
    result.object = stripReceiver(object, parameter);
  return result;
}

/**
 * Some packages wrap the whole script in an anonymous object: `return new Object() { fields; methods }.main()`.
 * Construction runs the field initializers in order and then the entry method, so the importer flattens it into
 * an ordinary script body: fields become declarations, methods become closure declarations (lowered to
 * functions like other closures), and the entry method's statements run last.
 */
function desugarObjectScript(
  body: AstNode | null,
  classes: AstNode[],
  context: LowerContext,
): AstNode | null {
  const statements = body?.kind === "block" ? nodeArray(body.statements) : [];
  const last = statements.at(-1);
  const call = last?.kind === "return" ? asNode(last.value) : null;
  const constructor = call?.kind === "methodCall" ? asNode(call.object) : null;
  const entryName = call === null ? null : constantString(call.method);
  const objectClass = classes.find((item) => item.name === constructor?.type);
  const callArguments = call === null ? [] : nodeArray(asNode(call.arguments)?.items);
  if (body === null || constructor?.kind !== "constructorCall" || objectClass === undefined)
    return body;
  const methods = nodeArray(objectClass.methods);
  const entry = methods.find((method) => method.name === entryName);
  const entryBody = asNode(entry?.body);
  if (entry === undefined || entryBody?.kind !== "block" || callArguments.length > 0) return body;

  const members: AstNode[] = [];
  for (const field of nodeArray(objectClass.fields)) {
    const left: AstNode = {
      kind: "variable",
      span: field.span,
      name: field.name,
      type: "java.lang.Object",
    };
    const right = asNode(field.initialExpression) ?? {
      kind: "constant",
      span: field.span,
      value: null,
    };
    const declaration = { kind: "declaration", span: field.span, left, right };
    members.push({ kind: "expressionStatement", span: field.span, expression: declaration });
  }
  for (const method of methods) {
    if (method === entry) continue;
    const left: AstNode = {
      kind: "variable",
      span: method.span,
      name: method.name,
      type: "java.lang.Object",
    };
    const closure: AstNode = {
      kind: "closure",
      span: method.span,
      parameters: method.parameters,
      parameterSpecified: true,
      body: method.body,
      implicitReturn: method.returnType !== "void",
    };
    const declaration = { kind: "declaration", span: method.span, left, right: closure };
    members.push({ kind: "expressionStatement", span: method.span, expression: declaration });
  }
  members.sort((left, right) => (left.span?.line ?? 0) - (right.span?.line ?? 0));
  const entryStatements = replaceModuleLoader(members, nodeArray(entryBody.statements), context);
  for (const nested of classes) {
    if (nested !== objectClass && nested.outerClass === objectClass.name) {
      addDiagnostic(
        context,
        "SX_NESTED_CLASS",
        "warning",
        `Nested class ${String(nested.name).split("$").at(-1)} has no TeaseScript equivalent; its constructor calls are reported where they occur.`,
        nested.span,
      );
    }
  }
  return { ...body, statements: [...statements.slice(0, -1), ...members, ...entryStatements] };
}

/**
 * Replaces a runtime module loader (directory listing plus Groovy evaluation of each file) by direct calls to the
 * package's mixin modules in file-name order, and the later `setups.each { it() }` by calls to their setup
 * functions. Mutates the loader member in place and returns the rewritten entry statements.
 */
function replaceModuleLoader(
  members: AstNode[],
  entryStatements: AstNode[],
  context: LowerContext,
): AstNode[] {
  let loaderName: string | null = null;
  let modules: MixinModuleInfo[] = [];
  for (const member of members) {
    const declaration = asNode(member.expression);
    const closure = asNode(declaration?.right);
    const name = variableName(declaration?.left);
    const directory = closure?.kind === "closure" ? moduleLoaderDirectory(closure) : null;
    if (declaration === null || closure === null || name === null || directory === null) continue;
    modules = context.mixinModules
      .filter((module) => module.directory === directory)
      .toSorted((left, right) => left.name.localeCompare(right.name));
    if (modules.length === 0) continue;
    // Replacing the loader would silently skip a file of that directory that is not a recognized module.
    const recognized = new Set(modules.map((module) => module.sourceName));
    const others = (context.directoryFiles.get(directory) ?? []).filter(
      (name) => !recognized.has(name),
    );
    if (others.length > 0) {
      addDiagnostic(
        context,
        "SX_MODULE_UNRECOGNIZED",
        "error",
        `The loader evaluates every file in scripts/${directory}, but ${others.map((name) => name.split(/[\\/]/u).at(-1)).join(", ")} ${others.length === 1 ? "is" : "are"} not a mixin module the importer can convert (for example a module whose result depends on its control flow); the loader is kept as written.`,
        closure.span,
      );
      modules = [];
      continue;
    }
    loaderName = name;
    context.loadsModuleDirectories.add(directory);
    const span = closure.span;
    const note: AstNode = {
      kind: "importerNote",
      span,
      code: "SX_MODULE_LOADER",
      message: `Replaced runtime loading of scripts/${directory}/*.groovy (directory listing and Groovy evaluation) with direct calls to its ${modules.length} modules in file-name order, the order Windows lists them.`,
    };
    declaration.right = {
      ...closure,
      parameters: [],
      parameterSpecified: true,
      body: {
        kind: "block",
        span,
        statements: [note, ...modules.map((module) => callStatement(module.loadFunction, span))],
      },
    };
  }
  if (loaderName === null) return entryStatements;

  const setupVariables = new Set<string>();
  return entryStatements.flatMap((statement): AstNode[] => {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const value = asNode(expression?.right);
    if (
      expression?.kind === "declaration" &&
      value !== null &&
      callParts(value)?.name === loaderName
    ) {
      const variable = variableName(expression.left);
      if (variable !== null) setupVariables.add(variable);
      return [callStatement(loaderName, statement.span)];
    }
    const call = expression === null ? null : callParts(expression);
    if (call?.name === loaderName) return [callStatement(loaderName, statement.span)];
    if (
      call?.name === "each" &&
      setupVariables.has(variableName(expression?.object) ?? "") &&
      call.arguments.length === 1 &&
      callsOwnParameter(call.arguments[0]!)
    ) {
      return modules.flatMap((module) =>
        module.setupFunction === null ? [] : [callStatement(module.setupFunction, statement.span)],
      );
    }
    return [statement];
  });
}

function callStatement(name: string, span: SourceSpan | null): AstNode {
  return {
    kind: "expressionStatement",
    span,
    expression: {
      kind: "methodCall",
      span,
      object: syntheticVariable("this", span),
      method: { kind: "constant", span, value: name },
      arguments: { kind: "arguments", span, items: [] },
      implicitThis: true,
      safe: false,
      spreadSafe: false,
    },
  };
}

/** The body of a one-parameter closure as its parameter name and single expression. */
function closureExpression(closure: AstNode): { parameter: string; expression: AstNode } | null {
  if (closure.kind !== "closure") return null;
  const parameters = groovyParameters(closure.parameters) ?? [];
  const parameter = closure.parameterSpecified === true ? parameters[0]?.name : "it";
  const statements = nodeArray(asNode(closure.body)?.statements);
  const only = statements.length === 1 ? statements[0] : undefined;
  const expression = asNode(only?.kind === "return" ? only.value : only?.expression);
  return parameter === undefined || parameters.length > 1 || expression === null
    ? null
    : { parameter, expression };
}

/** `{ p -> p() }`: runs each setup callback without arguments. */
function callsOwnParameter(closure: AstNode): boolean {
  const body = closureExpression(closure);
  const call = body === null ? null : callParts(body.expression);
  return (
    call !== null && call.inherited && call.name === body?.parameter && call.arguments.length === 0
  );
}

/**
 * The loader's file selection and result filter, exactly: `findAll { f -> f.name.endsWith(".groovy") }` and
 * `findAll { p -> p }`. Any other selection would load a different set of modules.
 */
function isModuleLoaderFilter(closure: AstNode): boolean {
  const body = closureExpression(closure);
  if (body === null) return false;
  if (variableName(body.expression) === body.parameter) return true;
  const call = callParts(body.expression);
  const receiver = asNode(body.expression.object);
  const argument = call?.arguments[0];
  return (
    call?.name === "endsWith" &&
    receiver?.kind === "property" &&
    constantString(receiver.property) === "name" &&
    variableName(receiver.object) === body.parameter &&
    argument?.kind === "constant" &&
    argument.value === ".groovy"
  );
}

/** Directories whose mixin modules a script loads at runtime. */
export function loadedModuleDirectories(file: ParsedGroovyFile): string[] {
  const directories = new Set<string>();
  walkAst(file.root, (node) => {
    const directory = node.kind === "closure" ? moduleLoaderDirectory(node) : null;
    if (directory !== null) directories.add(directory);
  });
  return [...directories];
}

/** Calls of a recognized loader: listing, the two filters, evaluation of each file, and calling its result. */
const LOADER_CALLS = new Set(["listFiles", "findAll", "collect", "me", "call", "endsWith"]);

/** `new File(".../scripts/<dir>").listFiles()` combined with `Eval.me(...)` marks a module loader closure. */
function moduleLoaderDirectory(closure: AstNode): string | null {
  let evaluates = false;
  let lists = false;
  let exact = true;
  let directory: string | null = null;
  walkAst(closure.body, (node) => {
    if (node.kind === "methodCall") {
      const name = constantString(node.method);
      // The loader evaluates each listed file's own text and nothing else happens to the list.
      if (name === null || !LOADER_CALLS.has(name)) exact = false;
      if (name === "me" && variableName(node.object) === "Eval") {
        evaluates = true;
        const source = nodeArray(asNode(node.arguments)?.items)[0];
        if (source?.kind !== "property" || constantString(source.property) !== "text")
          exact = false;
      }
      if (name === "listFiles") lists = true;
      if (name === "findAll") {
        const filter = nodeArray(asNode(node.arguments)?.items)[0];
        if (filter === undefined || !isModuleLoaderFilter(filter)) exact = false;
      }
    }
    if (node.kind === "constructorCall" && (node.type === "File" || node.type === "java.io.File")) {
      walkAst(node.arguments, (argument) => {
        const texts =
          argument.kind === "constant" && typeof argument.value === "string"
            ? [argument.value]
            : argument.kind === "gstring" && Array.isArray(argument.strings)
              ? argument.strings.filter((part): part is string => typeof part === "string")
              : [];
        for (const text of texts) {
          const match = /scripts\/([^/]+)\/?$/u.exec(text);
          if (match !== null) directory = match[1]!;
        }
      });
    }
  });
  return evaluates && lists && exact ? directory : null;
}

function collectClosureInfo(body: AstNode): Map<string, ClosureInfo> {
  const result = new Map<string, ClosureInfo>();
  for (const statement of nodeArray(body.statements)) {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    if (expression?.kind !== "declaration") continue;
    const name = variableName(expression.left);
    const closure = asNode(expression.right);
    if (name === null || closure?.kind !== "closure") continue;
    const implicitParameter = closure.parameterSpecified !== true;
    const parameters = groovyParameters(closure.parameters) ?? [];
    const minArgs = implicitParameter
      ? 0
      : parameters.filter((parameter) => parameter.defaultValue === null).length;
    result.set(name, {
      implicitParameter,
      minArgs,
      maxArgs: implicitParameter ? 0 : parameters.length,
    });
  }

  walkAst(body, (node) => {
    if (node.kind !== "methodCall" || node.implicitThis !== true) return;
    const name = constantString(node.method);
    if (name === null) return;
    const info = result.get(name);
    if (info === undefined || !info.implicitParameter) return;
    const argumentsNode = asNode(node.arguments);
    const argumentCount = argumentsNode === null ? 0 : nodeArray(argumentsNode.items).length;
    if (argumentCount === 1) info.maxArgs = 1;
  });
  return result;
}

/** Calls the action a closure value stands for through the generated package dispatcher. */
function actionCall(
  action: IrExpression,
  args: IrExpression[],
  context: LowerContext,
): IrExpression {
  context.actions.add(ACTION_DISPATCHER_MARKER);
  return {
    kind: "call",
    name: ACTION_DISPATCHER,
    positional: [action, { kind: "list", items: args }],
    named: {},
  };
}

function useHelper(context: LowerContext, name: HelperName, args: IrExpression[]): IrExpression {
  context.syntheticHelpers.add(name);
  return helperCall(name, args);
}

function unsupportedExpression(
  context: LowerContext,
  node: AstNode,
  code: string,
  message: string,
): null {
  addDiagnostic(context, code, "error", message, node.span);
  return null;
}

function unsupportedStatement(
  context: LowerContext,
  node: AstNode,
  code: string,
  message: string,
): IrStatement {
  addDiagnostic(context, code, "error", message, node.span);
  const legacySource = node.span === null ? [] : legacySourceLines(context, node.span);
  return { kind: "unsupported", legacySource, span: node.span };
}

/**
 * Renders the not-yet-rendered root causes added while lowering one statement as inline notes, so the
 * generated file explains what needs manual work at the place where it is needed.
 */
function diagnosticNotes(context: LowerContext, firstDiagnostic: number): IrStatement[] {
  const fresh = context.diagnostics
    .slice(firstDiagnostic)
    .filter(
      (diagnostic) =>
        diagnostic.severity !== "info" && !context.renderedDiagnostics.has(diagnostic),
    );
  for (const diagnostic of fresh) context.renderedDiagnostics.add(diagnostic);
  return rootDiagnostics(fresh).map((diagnostic) => {
    const label = diagnostic.severity === "error" ? "TODO" : "NOTE";
    const location = diagnostic.span === null ? "" : ` line ${diagnostic.span.line}`;
    return {
      kind: "comment",
      text: `// ${label} ${diagnostic.code}${location}: ${singleLine(diagnostic.message)}`,
      trailing: false,
      span: diagnostic.span,
    };
  });
}

/** Generated comment text must not contain line terminators, or the rest would become code. */
function singleLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/gu, " ");
}

function legacySourceLines(context: LowerContext, span: SourceSpan): string[] {
  const lines = context.sourceLines.slice(span.line - 1, span.endLine);
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => singleLine(line.slice(indent)).trimEnd());
}

function addDiagnostic(
  context: LowerContext,
  code: string,
  severity: "info" | "warning" | "error",
  message: string,
  span: SourceSpan | null,
): void {
  context.diagnostics.push({ code, severity, message, span });
}

function asNode(value: unknown): AstNode | null {
  return isAstNode(value) ? value : null;
}

function nodeArray(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isAstNode) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isLiteral(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function constantValue(node: AstNode | undefined): string | number | boolean | null | undefined {
  return node?.kind === "constant" && isLiteral(node.value) ? node.value : undefined;
}

function isTrueConstant(node: AstNode | null): boolean {
  return node?.kind === "constant" && node.value === true;
}

function isNullConstant(node: AstNode | undefined): boolean {
  return node?.kind === "constant" && node.value === null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function migrateScriptPath(value: string): string {
  return value.toLowerCase().endsWith(".groovy") ? `${value.slice(0, -7)}.tease` : `${value}.tease`;
}
