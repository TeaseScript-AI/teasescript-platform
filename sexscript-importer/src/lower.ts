import {
  constantString,
  groovyParameters,
  isAstNode,
  variableName,
  walkAst,
  type AstNode,
  type ParsedGroovyFile,
  type SourceComment,
  type SourceSpan,
} from "./ast.ts";
import { rootDiagnostics } from "./diagnostics.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
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
} from "./types.ts";
import type {
  IrExpression,
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
}

type SyntheticHelper = "loadFirstTrue" | "indexOf" | "concat";

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
  classLoaderVariables: Set<string>;
  legacyHelperClasses: Map<string, string>;
  helperFunctions: Map<string, HelperFunctionInfo>;
  helperMainParameter: string | null;
  packageHelperRegistry: HelperRegistry;
  syntheticHelpers: Set<SyntheticHelper>;
  functionDepth: number;
  comments: CommentQueue;
  /** Legacy source lines used to preserve code that needs manual migration. */
  sourceLines: string[];
  /** Diagnostics already rendered as inline notes in the generated output. */
  renderedDiagnostics: Set<MigrationDiagnostic>;
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

  const body = asNode(file.root.body);
  if (body?.kind === "block") {
    context.functions = collectClosureInfo(body);
    context.types = inferVariableTypes(body);
    const helpers = collectLegacyHelperBindings(body);
    context.classLoaderVariables = helpers.classLoaders;
    context.legacyHelperClasses = helpers.helperClasses;
  }
  const authoredStatements = withoutTrailingEnd(
    body?.kind === "block" ? lowerBlock(body, context) : [],
  );
  const statements = [...syntheticHelperStatements(context), ...authoredStatements];
  if (body?.kind !== "block") {
    addDiagnostic(
      context,
      "SX_INVALID_SCRIPT_BODY",
      "error",
      "Parser output does not contain a script body block.",
      file.root.span,
    );
  }

  return renameConflictingIdentifiers({
    sourceName: file.sourceName,
    metadata: context.metadata,
    statements,
    diagnostics: context.diagnostics,
  });
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
    statements: [...syntheticHelperStatements(baseContext), ...statements],
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
    types: inferVariableTypes(body),
    prelude: [],
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
  return { kind: "function", name, parameters, body: lowerBlock(body, context), span: method.span };
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
    const [prelude, lowered] = withPrelude(context, () => lowerStatement(statement, context));
    const only = lowered.length === 1 ? lowered[0] : undefined;
    if (only?.kind === "unsupported" && span !== null) {
      only.legacySource = legacySourceLines(context, span);
    }
    result.push(...diagnosticNotes(context, firstDiagnostic), ...prelude, ...lowered);
    if (span !== null) previousEndLine = span.endLine;
  }
  emitComments(takeCommentsBefore(context, enclosingSpan === null ? null : endOf(enclosingSpan)));
  return foldLoadDefaults(result);
}

/**
 * Folds the legacy "read, then fill in a missing value" idiom into one read:
 * `let x = load k` followed by `if x == null { x = d }` becomes `let x = load k default d`. The condition may
 * also accept `x == d`, because assigning `d` to a value that already equals `d` changes nothing.
 */
function foldLoadDefaults(statements: IrStatement[]): IrStatement[] {
  const result: IrStatement[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const current = statements[index]!;
    const next = statements[index + 1];
    const folded = next === undefined ? null : foldLoadDefault(current, next);
    if (folded === null) {
      result.push(current);
    } else {
      result.push(folded);
      index += 1;
    }
  }
  return result;
}

function foldLoadDefault(read: IrStatement, check: IrStatement): IrStatement | null {
  if (read.kind !== "let" && read.kind !== "assign") return null;
  const name =
    read.kind === "let"
      ? read.name
      : read.operator === "=" && read.target.kind === "variable"
        ? read.target.name
        : null;
  const value = read.value;
  if (name === null || value.kind !== "load" || value.defaultValue !== undefined) return null;
  if (check.kind !== "if" || check.else.length > 0 || check.then.length !== 1) return null;
  const fill = check.then[0]!;
  if (fill.kind !== "assign" || fill.operator !== "=" || !isVariable(fill.target, name))
    return null;
  if (fill.value.kind !== "literal") return null;
  if (!isMissingCheck(check.condition, name, fill.value.value)) return null;
  return { ...read, value: { ...value, defaultValue: fill.value } };
}

function isMissingCheck(
  condition: IrExpression,
  name: string,
  defaultValue: string | number | boolean | null,
): boolean {
  const equals = (expression: IrExpression, literal: string | number | boolean | null): boolean =>
    expression.kind === "binary" &&
    expression.operator === "==" &&
    isVariable(expression.left, name) &&
    expression.right.kind === "literal" &&
    expression.right.value === literal;
  if (equals(condition, null)) return true;
  return (
    condition.kind === "binary" &&
    condition.operator === "or" &&
    equals(condition.left, null) &&
    equals(condition.right, defaultValue)
  );
}

function isVariable(expression: IrExpression, name: string): boolean {
  return expression.kind === "variable" && expression.name === name;
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
  return statements[lastCode]?.kind === "end" ? statements.toSpliced(lastCode, 1) : statements;
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
      return [{ kind: "break", span: node.span }];
    case "continue":
      return [{ kind: "continue", span: node.span }];
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

  const split = splitConditional(conditional, span, context);
  if (split === null) return null;
  if (!isPure(split.condition)) {
    return [
      unsupportedStatement(
        context,
        conditional,
        "SX_CONDITIONAL_SIDE_EFFECT",
        "This conditional expression has a condition with side effects inside a larger statement; rewrite it with an explicit if.",
      ),
    ];
  }
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
    const loadWithDefault = legacyLoadWithDefault(value, fallback, context);
    if (loadWithDefault !== null) return lowerStatement(assign(loadWithDefault), context);
    // `x = x ?: d` needs no self-assignment before the check.
    const reassignsSelf = !declaration && variableName(value) === variableName(target);
    return [
      ...(reassignsSelf ? [] : lowerStatement(assign(value), context)),
      ...lowerStatement(syntheticIf(syntheticNot(target), update(fallback), null, span), context),
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
  // Start from a side-effect-free branch value so the result reads like ordinary TeaseScript.
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
  span: SourceSpan | null,
  context: LowerContext,
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
  const loadWithDefault = legacyLoadWithDefault(value, fallback, context);
  if (loadWithDefault !== null) {
    return {
      condition: syntheticConstant(true, span),
      whenTrue: loadWithDefault,
      whenFalse: fallback,
    };
  }
  if (!isRepeatableExpression(value)) return null;
  return { condition: value, whenTrue: value, whenFalse: fallback };
}

/**
 * `loadX(key) ?: fallback` maps to `load key default fallback`. Groovy's Elvis also replaces a stored false,
 * zero, or empty value; TeaseScript's default only replaces a missing key.
 */
function legacyLoadWithDefault(
  value: AstNode,
  fallback: AstNode,
  context: LowerContext,
): AstNode | null {
  const call = callParts(value);
  if (call === null || !call.inherited || call.arguments.length !== 1) return null;
  if (!DIRECT_STORAGE_LOADS.has(call.name) || context.helperMainParameter !== null) return null;
  const typed = typedLegacyLoad(value);
  const exact =
    typed !== null && fallback.kind === "constant" && fallback.value === typed.falseValue.value;
  if (!exact) {
    addDiagnostic(
      context,
      "SX_ELVIS_LOAD_DEFAULT",
      "warning",
      "Groovy ?: also used the fallback when the stored value was false, zero, or empty; load ... default only applies to a missing key.",
      value.span,
    );
  }
  return { kind: "loadWithDefault", span: value.span, key: call.arguments[0], fallback };
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

/** Values that are safe and readable as an unconditional initial value. */
function isSimpleValue(node: AstNode): boolean {
  if (node.kind === "constant" || node.kind === "variable") return true;
  if (node.kind === "unaryMinus") return asNode(node.value)?.kind === "constant";
  if (node.kind === "gstring") return nodeArray(node.values).every(isSimpleValue);
  if (node.kind === "list") return nodeArray(node.items).every(isSimpleValue);
  return false;
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
function isPure(node: AstNode): boolean {
  if (node.kind === "methodCall") {
    const call = callParts(node);
    if (call === null) return false;
    const pureCall = call.inherited
      ? DIRECT_STORAGE_LOADS.has(call.name)
      : PURE_OBJECT_METHODS.has(call.name);
    const target = asNode(node.object);
    return (
      pureCall &&
      (call.inherited || target === null || isPure(target)) &&
      call.arguments.every(isPure)
    );
  }
  if (node.kind === "binary" && typeof node.operator === "string" && node.operator.endsWith("=")) {
    return ["==", "!=", "<=", ">="].includes(node.operator) && nodeChildren(node).every(isPure);
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
  return pureKinds.has(node.kind) && nodeChildren(node).every(isPure);
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
  if (expression.kind === "binary") return lowerAssignment(expression, node.span, context);
  if (expression.kind === "postfix") return lowerPostfix(expression, node.span, context);
  if (expression.kind === "methodCall") return lowerCallStatement(expression, node.span, context);

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
  if (context.functions.has(name)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_FUNCTION_LOCAL_NAME_CONFLICT",
        `Variable ${name} conflicts with a migrated closure function of the same name.`,
      ),
    ];
  }
  // `def x` without an initializer starts as null in Groovy.
  const value = isEmptyGroovyExpression(right)
    ? { kind: "literal" as const, value: null }
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
    return [
      unsupportedStatement(
        context,
        closure,
        "SX_NESTED_CLOSURE",
        "Nested Groovy closures are not lowered automatically.",
      ),
    ];
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
    if (info.maxArgs === 1)
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
  context.functionDepth += 1;
  try {
    return [{ kind: "function", name, parameters, body: lowerBlock(body, context), span }];
  } finally {
    context.functionDepth -= 1;
  }
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
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target, name: "add", arguments: [value] },
          span,
        },
      ];
    }
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
  let target: IrExpression | null = null;
  if (variableTarget !== null) target = { kind: "variable", name: variableTarget };
  else if (operator === "=" && targetNode.kind === "binary" && targetNode.operator === "[") {
    target = lowerExpression(targetNode, context);
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
  if (call !== null && !call.inherited && call.name === "each") {
    return lowerEachStatement(node, call.arguments, span, context);
  }
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
  if (call !== null && !call.inherited && receiverName === "System" && call.name === "exit") {
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
  if (context.helperFunctions.has(call.name)) {
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
  switch (call.name) {
    case "setInfos":
      extractMetadata(args, context, node.span);
      return [];
    case "show":
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
  if (containsReturnForCurrentClosure(body)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_RETURN",
        "Groovy return inside each() returns from the closure and needs a dedicated control-flow rewrite.",
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
  return [{ kind: "for", variable, collection, body: lowerBlock(body, context), span }];
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
  if (args.length < 1 || args.length > 2 || isNullConstant(args[0])) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_BACKGROUND_SOUND_CONTROL",
        "Null/global stop behavior for background sound needs manual migration.",
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
  return [{ kind: "playAudio", file, async: true, repeatCount, span }];
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
  const [prelude, lowered] = withPrelude(context, () => lowerStatement(node, context));
  return [...prelude, ...lowered];
}

function lowerWhile(node: AstNode, context: LowerContext): IrStatement[] {
  const conditionNode = asNode(node.condition);
  const body = asNode(node.body);
  const [prelude, condition] = withPrelude(context, () =>
    conditionNode === null ? null : lowerCondition(conditionNode, context),
  );
  if (condition !== null && body?.kind === "block" && prelude.length > 0) {
    // The prompt must be shown before every evaluation of the condition, not once before the loop.
    return [
      {
        kind: "while",
        condition: { kind: "literal", value: true },
        body: [...prelude, breakUnless(condition), ...lowerBlock(body, context)],
        span: node.span,
      },
    ];
  }
  if (condition === null || body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_WHILE",
        "while condition or body could not be migrated safely.",
      ),
    ];
  }
  return [{ kind: "while", condition, body: lowerBlock(body, context), span: node.span }];
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
  if (containsContinueForCurrentLoop(body)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_C_STYLE_CONTINUE",
        "C-style for loop contains continue; its update step must run before continuing, so this loop needs a dedicated rewrite.",
      ),
    ];
  }

  const initial = parts[0]!;
  const conditionNode = parts[1]!;
  const update = parts[2]!;
  const initialStatements = lowerForControlExpression(initial, context);
  const [prelude, condition] = withPrelude(context, () => lowerCondition(conditionNode, context));
  const updateStatements = lowerForControlExpression(update, context);
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

  return [
    ...initialStatements,
    {
      kind: "while",
      condition,
      body: [...lowerBlock(body, context), ...updateStatements],
      span: node.span,
    },
  ];
}

function lowerForControlExpression(node: AstNode, context: LowerContext): IrStatement[] | null {
  if (node.kind === "declaration") return lowerDeclaration(node, node.span, context);
  if (node.kind === "binary") return lowerAssignment(node, node.span, context);
  if (node.kind === "postfix") return lowerPostfix(node, node.span, context);
  return null;
}

function containsContinueForCurrentLoop(node: AstNode, root = true): boolean {
  if (!root && (node.kind === "for" || node.kind === "while")) return false;
  if (node.kind === "continue") return true;
  for (const value of Object.values(node)) {
    if (isAstNode(value) && containsContinueForCurrentLoop(value, false)) return true;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item) && containsContinueForCurrentLoop(item, false)) return true;
      }
    }
  }
  return false;
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
    const loweredBody = lowerStatementList(sourceStatements, null, context);
    cases.push({ span: caseNode.span, match, body: loweredBody });
  }

  const defaultStatements = lowerStatementList(withoutTerminalBreak(defaultSource), null, context);
  return [{ kind: "switch", value, cases, default: defaultStatements, span: node.span }];
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
    if (terminal?.kind === "break" || terminal?.kind === "return") return result;
  }
  result.push(...withoutTerminalBreak(defaultSource));
  return result;
}

function switchBodyStatements(node: AstNode | null): AstNode[] | null {
  if (node === null || node.kind === "empty") return [];
  return node.kind === "block" ? nodeArray(node.statements) : [node];
}

function withoutTerminalBreak(statements: AstNode[]): AstNode[] {
  return statements.at(-1)?.kind === "break" ? statements.slice(0, -1) : statements;
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
      if (context.helperMainParameter !== null && name === context.helperMainParameter) {
        return unsupportedExpression(
          context,
          node,
          "SX_HELPER_MAIN_VALUE",
          "The legacy SexScript host object cannot become an authored TeaseScript value.",
        );
      }
      if (context.functions.has(name)) {
        return unsupportedExpression(
          context,
          node,
          "SX_FUNCTION_VALUE_REFERENCE",
          `Groovy closure ${name} is used as a value instead of being called.`,
        );
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
    case "loadWithDefault": {
      const keyNode = asNode(node.key);
      const fallbackNode = asNode(node.fallback);
      const key = keyNode === null ? null : lowerExpression(keyNode, context);
      const fallback = fallbackNode === null ? null : lowerExpression(fallbackNode, context);
      return key === null || fallback === null
        ? null
        : { kind: "load", key, defaultValue: fallback };
    }
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
    default:
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_EXPRESSION",
        `Unsupported Groovy expression: ${node.kind}`,
      );
  }
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
    const calendarIndex = calendarConstant(indexNode);
    if (calendarIndex !== null) return dateTimeField(calendarIndex, target, node, context);
    if (targetNode !== null && isRandomIndexOf(indexNode, targetNode)) {
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
  const mapped = operator;
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
  const legacyLoad = typedLegacyLoad(node);
  if (legacyLoad !== null) {
    // A missing key reads as null, which Groovy treats like the type's false value.
    const key = lowerExpression(legacyLoad.key, context);
    if (key === null) return null;
    const value: IrExpression = { kind: "load", key, defaultValue: legacyLoad.falseValue };
    return legacyLoad.falseValue.value === false
      ? value
      : { kind: "binary", operator: "!=", left: value, right: legacyLoad.falseValue };
  }
  const value = lowerExpression(node, context);
  if (value === null) return null;
  const type = inferType(node, context.types);
  if (onlyOf(type, BOOLEAN)) return value;
  const repeatable = isRepeatableExpression(node);
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
  if (onlyOf(type, NULL | OBJECT)) return notNull;
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
): { key: AstNode; falseValue: { kind: "literal"; value: boolean | number | string } } | null {
  const call = callParts(node);
  if (call === null || !call.inherited || call.arguments.length !== 1) return null;
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
  const leftType = inferType(leftNode, context.types);
  const rightType = inferType(rightNode, context.types);
  if (isListType(leftType)) {
    if (!isListType(rightType)) {
      return unsupportedExpression(
        context,
        node,
        "SX_LIST_CONCATENATION",
        "Groovy list + with a non-list operand appends one element; rewrite it with add().",
      );
    }
    const lists = listConcatenationOperands(node, context);
    if (lists === null) return null;
    context.syntheticHelpers.add("concat");
    return {
      kind: "call",
      name: "sexscriptLegacyConcat",
      positional: [{ kind: "list", items: lists }],
      named: {},
    };
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
      const left = listConcatenationOperands(leftNode, context);
      const right = rightNode === null ? null : lowerExpression(rightNode, context);
      return left === null || right === null ? null : [...left, right];
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

/** Recognizes `getRandom(list.size)`, `getRandom(list.size())`, or `getRandom(list.length)` for `list`. */
function isRandomIndexOf(index: AstNode, list: AstNode): boolean {
  const call = callParts(index);
  if (
    call === null ||
    !call.inherited ||
    call.name !== "getRandom" ||
    call.arguments.length !== 1
  ) {
    return false;
  }
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
  if (property === "size" && isKnownListExpression(targetNode, context)) {
    const target = lowerExpression(targetNode, context);
    return target === null ? null : { kind: "property", target, name: "length" };
  }
  return unsupportedExpression(
    context,
    node,
    "SX_UNSUPPORTED_PROPERTY",
    `Groovy property .${property} is not safely mapped for this receiver.`,
  );
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
          `Legacy helper ${helperClass}.${name}() does not pass the script host as its first argument.`,
        );
      }
      argumentNodes = argumentNodes.slice(1);
    }
    if (argumentNodes.length < helperInfo.minArgs || argumentNodes.length > helperInfo.maxArgs) {
      return unsupportedExpression(
        context,
        node,
        "SX_FUNCTION_ARITY",
        `Call to ${helperClass}.${name} has ${argumentNodes.length} authored arguments; expected ${helperInfo.minArgs}..${helperInfo.maxArgs}.`,
      );
    }
    const args = lowerArguments(argumentNodes, context);
    return args === null ? null : { kind: "call", name, positional: args, named: {} };
  }

  if (receiverName === "Math") {
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
    const args = lowerArguments(argumentsNodes, context);
    return args === null ? null : { kind: "methodCall", target, name, arguments: args };
  }
  if (name === "indexOf" && argumentsNodes.length === 1) {
    const args = lowerArguments(argumentsNodes, context);
    if (args === null) return null;
    context.syntheticHelpers.add("indexOf");
    return {
      kind: "call",
      name: "sexscriptLegacyIndexOf",
      positional: [target, args[0]!],
      named: {},
    };
  }
  return unsupportedExpression(
    context,
    node,
    "SX_UNSUPPORTED_LIST_METHOD",
    `Groovy list method ${name}() is not safely mapped yet.`,
  );
}

/** A null receiver fails in Groovy and TeaseScript alike, so "list or null" counts as a list receiver. */
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
  if (
    instance === null ||
    instance.name !== "getInstance" ||
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
    return args === null ? null : { kind: "call", name: call.name, positional: args, named: {} };
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
    return args === null ? null : { kind: "call", name: call.name, positional: args, named: {} };
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
    context.syntheticHelpers.add("loadFirstTrue");
    return {
      kind: "call",
      name: "sexscriptLegacyLoadFirstTrue",
      positional: [{ kind: "list", items: keys }],
      named: {},
    };
  }

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
      return {
        kind: "call",
        name: "randomInteger",
        positional: [
          { kind: "range", from: { kind: "literal", value: 0 }, to: args[0]!, inclusive: false },
        ],
        named: {},
      };
    case "getTime":
      return args.length === 0
        ? { kind: "call", name: "getSeconds", positional: [], named: {} }
        : unsupportedExpression(
            context,
            node,
            "SX_TIME_ARITY",
            "getTime() must have no arguments.",
          );
    case "getBoolean":
      if (args.length === 1)
        return { kind: "call", name: "askBoolean", positional: args, named: {} };
      if (args.length === 3)
        return {
          kind: "call",
          name: "askBoolean",
          positional: [],
          named: { message: args[0]!, yesText: args[1]!, noText: args[2]! },
        };
      return unsupportedExpression(
        context,
        node,
        "SX_BOOLEAN_ARITY",
        "getBoolean() must have one or three arguments.",
      );
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
    case "getSelectedValue":
      return lowerSelectedValue(node, call.arguments, context);
    default:
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
    // Accepted V30 integer input; compact syntax exists only for text and number input.
    return { kind: "call", name: "askInteger", positional: [args[0]!], named: {} };
  }
  context.prelude.push(promptSay(args[0]!, node.span));
  return { kind: "input", input: name === "getString" ? "askText" : "askNumber" };
}

function isEmptyDefault(node: AstNode): boolean {
  return node.kind === "constant" && (node.value === null || node.value === "");
}

function promptSay(message: IrExpression, span: SourceSpan | null): IrStatement {
  return { kind: "say", value: message, span };
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
  context.prelude.push(promptSay(message, node.span));
  return { kind: "choice", options };
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

function syntheticHelperStatements(context: LowerContext): IrStatement[] {
  const result: IrStatement[] = [];
  if (context.syntheticHelpers.has("loadFirstTrue")) result.push(loadFirstTrueHelper());
  if (context.syntheticHelpers.has("indexOf")) result.push(indexOfHelper());
  if (context.syntheticHelpers.has("concat")) result.push(concatHelper());
  return result;
}

/** Groovy `a + b + c` on lists creates a new list; TeaseScript has no list operator for that. */
function concatHelper(): IrStatement {
  const variable = (name: string): IrExpression => ({ kind: "variable", name });
  return {
    kind: "function",
    name: "sexscriptLegacyConcat",
    parameters: [{ name: "lists", defaultValue: null }],
    span: null,
    body: [
      { kind: "let", name: "combined", value: { kind: "list", items: [] }, span: null },
      {
        kind: "for",
        variable: "list",
        collection: variable("lists"),
        span: null,
        body: [
          {
            kind: "for",
            variable: "item",
            collection: variable("list"),
            span: null,
            body: [
              {
                kind: "expression",
                expression: {
                  kind: "methodCall",
                  target: variable("combined"),
                  name: "add",
                  arguments: [variable("item")],
                },
                span: null,
              },
            ],
          },
        ],
      },
      { kind: "return", value: variable("combined"), span: null },
    ],
  };
}

function loadFirstTrueHelper(): IrStatement {
  return {
    kind: "function",
    name: "sexscriptLegacyLoadFirstTrue",
    parameters: [{ name: "keys", defaultValue: null }],
    span: null,
    body: [
      {
        kind: "for",
        variable: "key",
        collection: { kind: "variable", name: "keys" },
        span: null,
        body: [
          {
            kind: "let",
            name: "value",
            value: { kind: "load", key: { kind: "variable", name: "key" } },
            span: null,
          },
          {
            kind: "if",
            condition: {
              kind: "binary",
              operator: "==",
              left: { kind: "variable", name: "value" },
              right: { kind: "literal", value: true },
            },
            then: [{ kind: "return", value: { kind: "variable", name: "key" }, span: null }],
            else: [],
            span: null,
          },
        ],
      },
      { kind: "return", value: { kind: "literal", value: null }, span: null },
    ],
  };
}

function indexOfHelper(): IrStatement {
  return {
    kind: "function",
    name: "sexscriptLegacyIndexOf",
    parameters: [
      { name: "items", defaultValue: null },
      { name: "value", defaultValue: null },
    ],
    span: null,
    body: [
      { kind: "let", name: "index", value: { kind: "literal", value: 0 }, span: null },
      {
        kind: "for",
        variable: "item",
        collection: { kind: "variable", name: "items" },
        span: null,
        body: [
          {
            kind: "if",
            condition: {
              kind: "binary",
              operator: "==",
              left: { kind: "variable", name: "item" },
              right: { kind: "variable", name: "value" },
            },
            then: [{ kind: "return", value: { kind: "variable", name: "index" }, span: null }],
            else: [],
            span: null,
          },
          {
            kind: "assign",
            target: { kind: "variable", name: "index" },
            operator: "+=",
            value: { kind: "literal", value: 1 },
            span: null,
          },
        ],
      },
      { kind: "return", value: { kind: "literal", value: -1 }, span: null },
    ],
  };
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
      text: `// ${label} ${diagnostic.code}${location}: ${diagnostic.message}`,
      trailing: false,
      span: diagnostic.span,
    };
  });
}

function legacySourceLines(context: LowerContext, span: SourceSpan): string[] {
  const lines = context.sourceLines.slice(span.line - 1, span.endLine);
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(indent).trimEnd());
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
