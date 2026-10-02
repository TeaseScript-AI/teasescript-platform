import { constantString, isAstNode, variableName, walkAst, type AstNode, type ParsedGroovyFile, type SourceSpan } from "./ast.ts";
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

type SyntheticHelper = "loadFirstTrue" | "indexOf";

interface LowerContext {
  diagnostics: MigrationDiagnostic[];
  metadata: LegacyMetadata | null;
  functions: Map<string, ClosureInfo>;
  listVariables: Set<string>;
  classLoaderVariables: Set<string>;
  legacyHelperClasses: Map<string, string>;
  helperFunctions: Map<string, HelperFunctionInfo>;
  helperMainParameter: string | null;
  packageHelperRegistry: HelperRegistry;
  syntheticHelpers: Set<SyntheticHelper>;
  functionDepth: number;
}

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

export function lowerParsedFile(file: ParsedGroovyFile, options: LowerOptions = {}): MigrationProgram {
  const context: LowerContext = {
    diagnostics: [],
    metadata: null,
    functions: new Map(),
    listVariables: new Set(),
    classLoaderVariables: new Set(),
    legacyHelperClasses: new Map(),
    helperFunctions: new Map(),
    helperMainParameter: null,
    packageHelperRegistry: options.helperRegistry ?? new Map(),
    syntheticHelpers: new Set(),
    functionDepth: 0,
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
    return { sourceName: file.sourceName, metadata: null, statements: [], diagnostics: context.diagnostics };
  }

  if (file.root.kind === "compilationUnit") return lowerHelperCompilationUnit(file, context);
  if (file.root.kind !== "scriptBody") {
    context.diagnostics.push({
      code: "SX_UNIT_LOWERING_DEFERRED",
      severity: "error",
      message: "Non-script Groovy input is parsed but not lowered by the importer.",
      span: file.root.span,
    });
    return { sourceName: file.sourceName, metadata: null, statements: [], diagnostics: context.diagnostics };
  }

  const body = asNode(file.root.body);
  if (body?.kind === "block") {
    context.functions = collectClosureInfo(body);
    context.listVariables = collectListVariables(body);
    const helpers = collectLegacyHelperBindings(body);
    context.classLoaderVariables = helpers.classLoaders;
    context.legacyHelperClasses = helpers.helperClasses;
  }
  const authoredStatements = body?.kind === "block" ? lowerBlock(body, context) : [];
  const statements = [...syntheticHelperStatements(context), ...authoredStatements];
  if (body?.kind !== "block") {
    addDiagnostic(context, "SX_INVALID_SCRIPT_BODY", "error", "Parser output does not contain a script body block.", file.root.span);
  }

  return {
    sourceName: file.sourceName,
    metadata: context.metadata,
    statements,
    diagnostics: context.diagnostics,
  };
}


function lowerHelperCompilationUnit(file: ParsedGroovyFile, baseContext: LowerContext): MigrationProgram {
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
    return { sourceName: file.sourceName, metadata: null, statements: [], diagnostics: baseContext.diagnostics };
  }
  const helperClass = classes[0]!;
  const methods = nodeArray(helperClass.methods);
  const helperFunctions = collectHelperFunctionInfo(methods);
  const statements: IrStatement[] = [];
  for (const method of methods) {
    const lowered = lowerHelperMethod(method, baseContext, helperFunctions);
    if (lowered !== null) statements.push(lowered);
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
    const rawParameters = Array.isArray(method.parameters) ? method.parameters : [];
    const records = rawParameters.filter(
      (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
    );
    const stripsMain = records[0]?.name === "main";
    const authored = stripsMain ? records.slice(1) : records;
    const minArgs = authored.filter((parameter) => parameter.hasInitialExpression !== true).length;
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
    addDiagnostic(baseContext, "SX_HELPER_METHOD", "error", "Auxiliary helper contains an invalid method.", method.span);
    return null;
  }
  const rawParameters = Array.isArray(method.parameters) ? method.parameters : [];
  const records: Record<string, unknown>[] = [];
  for (const value of rawParameters) {
    if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>).name !== "string") {
      addDiagnostic(baseContext, "SX_HELPER_PARAMETER", "error", `Helper method ${name} has an invalid parameter.`, method.span);
      return null;
    }
    records.push(value as Record<string, unknown>);
  }
  const stripsMain = records[0]?.name === "main";
  const authoredRecords = stripsMain ? records.slice(1) : records;
  const body = asNode(method.body);
  if (body?.kind !== "block") {
    addDiagnostic(baseContext, "SX_HELPER_BODY", "error", `Helper method ${name} does not contain a normal block body.`, method.span);
    return null;
  }
  const context: LowerContext = {
    diagnostics: baseContext.diagnostics,
    metadata: baseContext.metadata,
    functions: collectClosureInfo(body),
    listVariables: collectListVariables(body),
    classLoaderVariables: new Set(),
    legacyHelperClasses: new Map(),
    helperFunctions,
    helperMainParameter: stripsMain ? "main" : null,
    packageHelperRegistry: baseContext.packageHelperRegistry,
    syntheticHelpers: baseContext.syntheticHelpers,
    functionDepth: 1,
  };
  const parameters: IrFunctionParameter[] = [];
  for (const parameter of authoredRecords) {
    const parameterName = String(parameter.name);
    const initial = asNode(parameter.initialExpression);
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
  const statements = nodeArray(block.statements);
  const result: IrStatement[] = [];
  for (const statement of statements) result.push(...lowerStatement(statement, context));
  return result;
}

function lowerStatement(node: AstNode, context: LowerContext): IrStatement[] {
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
      return [unsupportedStatement(context, node, "SX_UNSUPPORTED_STATEMENT", `Unsupported Groovy statement: ${node.kind}`)];
  }
}

function lowerExpressionStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const expression = asNode(node.expression);
  if (expression === null) return [unsupportedStatement(context, node, "SX_MISSING_EXPRESSION", "Missing expression.")];

  if (expression.kind === "declaration") return lowerDeclaration(expression, node.span, context);
  if (expression.kind === "binary") return lowerAssignment(expression, node.span, context);
  if (expression.kind === "postfix") return lowerPostfix(expression, node.span, context);
  if (expression.kind === "methodCall") return lowerCallStatement(expression, node.span, context);

  const lowered = lowerExpression(expression, context);
  if (lowered === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_EXPRESSION_STATEMENT", "Expression statement could not be migrated safely.")];
  }
  return [{ kind: "expression", expression: lowered, span: node.span }];
}

function lowerDeclaration(node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  const name = variableName(node.left);
  const right = asNode(node.right);
  if (name === null || right === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_DECLARATION", "Only single-variable declarations are supported.")];
  }
  if (right.kind === "closure") return lowerClosureDeclaration(name, right, span, context);
  if (context.classLoaderVariables.has(name) && isGroovyClassLoaderConstructor(right)) {
    addDiagnostic(context, "SX_LEGACY_HELPER_SETUP", "info", `Removed GroovyClassLoader setup variable ${name}; helper source is migrated separately.`, span);
    return [];
  }
  const helperClass = context.legacyHelperClasses.get(name);
  if (helperClass !== undefined && isLegacyLoadClassCall(right, context.classLoaderVariables)) {
    addDiagnostic(context, "SX_LEGACY_HELPER_SETUP", "info", `Removed loadClass setup for ${helperClass}; helper calls remain explicit migration candidates.`, span);
    return [];
  }
  if (context.functions.has(name)) {
    return [unsupportedStatement(
      context,
      node,
      "SX_FUNCTION_LOCAL_NAME_CONFLICT",
      `Variable ${name} conflicts with a migrated closure function of the same name.`,
    )];
  }
  const value = lowerExpression(right, context);
  if (value === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_DECLARATION_VALUE", `Cannot safely migrate initializer for ${name}.`)];
  }
  return [{ kind: "let", name, value, span }];
}

function lowerClosureDeclaration(
  name: string,
  closure: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (context.functionDepth !== 0) {
    return [unsupportedStatement(context, closure, "SX_NESTED_CLOSURE", "Nested Groovy closures are not lowered automatically.")];
  }
  const info = context.functions.get(name);
  if (info === undefined) {
    return [unsupportedStatement(context, closure, "SX_CLOSURE_DISCOVERY", `Closure ${name} was not discovered during the prepass.`)];
  }

  const parameters: IrFunctionParameter[] = [];
  if (info.implicitParameter) {
    if (info.maxArgs === 1) parameters.push({ name: "it", defaultValue: { kind: "literal", value: null } });
  } else {
    const rawParameters = Array.isArray(closure.parameters) ? closure.parameters : [];
    for (const raw of rawParameters) {
      if (typeof raw !== "object" || raw === null || typeof (raw as Record<string, unknown>).name !== "string") {
        return [unsupportedStatement(context, closure, "SX_CLOSURE_PARAMETER", `Closure ${name} has an invalid parameter.`)];
      }
      const record = raw as Record<string, unknown>;
      const defaultNode = asNode(record.default);
      const defaultValue = defaultNode === null ? null : lowerExpression(defaultNode, context);
      if (defaultNode !== null && defaultValue === null) {
        return [unsupportedStatement(context, closure, "SX_CLOSURE_PARAMETER_DEFAULT", `Default value for ${String(record.name)} could not be migrated.`)];
      }
      parameters.push({ name: String(record.name), defaultValue });
    }
  }

  const body = asNode(closure.body);
  if (body?.kind !== "block") {
    return [unsupportedStatement(context, closure, "SX_CLOSURE_BODY", `Closure ${name} does not contain a normal block body.`)];
  }
  context.functionDepth += 1;
  try {
    return [{ kind: "function", name, parameters, body: lowerBlock(body, context), span }];
  } finally {
    context.functionDepth -= 1;
  }
}

function lowerAssignment(node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  const operator = text(node.operator);
  if (operator !== "=" && operator !== "+=" && operator !== "-=" && operator !== "*=" && operator !== "/=") {
    const lowered = lowerExpression(node, context);
    return lowered === null
      ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_BINARY_STATEMENT", `Unsupported binary statement operator ${operator ?? "?"}.`)]
      : [{ kind: "expression", expression: lowered, span }];
  }
  const targetNode = asNode(node.left);
  const right = asNode(node.right);
  if (targetNode === null || right === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_ASSIGNMENT_TARGET", "Assignment target or value is missing.")];
  }
  const variableTarget = variableName(targetNode);
  let target: IrExpression | null = null;
  if (variableTarget !== null) target = { kind: "variable", name: variableTarget };
  else if (operator === "=" && targetNode.kind === "binary" && targetNode.operator === "[") {
    target = lowerExpression(targetNode, context);
  }
  if (target === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_ASSIGNMENT_TARGET", "Only local variables and indexed list targets are migrated automatically.")];
  }
  const value = lowerExpression(right, context);
  if (value === null) {
    const targetName = variableTarget ?? "indexed target";
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_ASSIGNMENT_VALUE", `Cannot safely migrate assignment to ${targetName}.`)];
  }
  if (operator === "*=" || operator === "/=") {
    if (variableTarget === null) {
      return [unsupportedStatement(context, node, "SX_UNSUPPORTED_ASSIGNMENT_TARGET", "Compound assignment to an indexed target requires single-evaluation rewriting.")];
    }
    return [{
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
    }];
  }
  return [{ kind: "assign", target, operator, value, span }];
}

function lowerPostfix(node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  const operator = text(node.operator);
  const target = variableName(node.value);
  if ((operator !== "++" && operator !== "--") || target === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_POSTFIX", "Only local-variable ++/-- statements are supported.")];
  }
  return [{
    kind: "assign",
    target: { kind: "variable", name: target },
    operator: operator === "++" ? "+=" : "-=",
    value: { kind: "literal", value: 1 },
    span,
  }];
}

function lowerCallStatement(node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  const call = callParts(node);
  if (call !== null && !call.inherited && call.name === "each") {
    return lowerEachStatement(node, call.arguments, span, context);
  }
  const receiverName = variableName(node.object);
  if (call !== null && receiverName !== null && context.classLoaderVariables.has(receiverName) && call.name === "addClasspath") {
    addDiagnostic(context, "SX_LEGACY_HELPER_SETUP", "info", "Removed GroovyClassLoader classpath setup; helper source is migrated separately.", span);
    return [];
  }
  if (call === null || !call.inherited) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_CALL", "Method call is not a supported SexScript call.")]
      : [{ kind: "expression", expression, span }];
  }
  if (call.name === "sleep" && context.helperMainParameter !== null) {
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
      ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_HELPER_CALL", `Helper call ${call.name}() could not be migrated.`)]
      : [{ kind: "expression", expression, span }];
  }
  if (context.helperMainParameter !== null && variableName(node.object) !== context.helperMainParameter) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_HELPER_CALL", `Unqualified helper call ${call.name}() could not be migrated.`)]
      : [{ kind: "expression", expression, span }];
  }

  const args = call.arguments;
  switch (call.name) {
    case "setInfos":
      extractMetadata(args, context, node.span);
      return [];
    case "show":
      return oneArgumentStatement(args, context, node, (value) => ({ kind: "say", value, span }));
    case "wait":
      return oneArgumentStatement(args, context, node, (duration) => ({ kind: "wait", duration, visible: false, unit: "s", span }));
    case "waitWithGauge":
      return oneArgumentStatement(args, context, node, (duration) => ({ kind: "wait", duration, visible: true, unit: "s", span }));
    case "showButton": {
      if (args.length < 1 || args.length > 2) {
        return [unsupportedStatement(context, node, "SX_BUTTON_ARITY", "showButton() must have one or two arguments.")];
      }
      const label = lowerExpression(args[0]!, context);
      const timeout = args[1] === undefined ? null : lowerExpression(args[1], context);
      if (label === null || (args[1] !== undefined && timeout === null)) {
        return [unsupportedStatement(context, node, "SX_UNSUPPORTED_BUTTON_ARGUMENT", "showButton() arguments could not be migrated.")];
      }
      return [{ kind: "showButton", label, timeout, span }];
    }
    case "showPopup":
      return oneArgumentStatement(args, context, node, (message) => ({ kind: "showPopup", message, span }));
    case "setImage":
      if (args.length !== 1) return [unsupportedStatement(context, node, "SX_SET_IMAGE_ARITY", "setImage byte-array overload is not automatically migrated.")];
      if (isNullConstant(args[0])) return [{ kind: "hideImage", span }];
      return oneArgumentStatement(args, context, node, (file) => ({ kind: "showImage", file, span }));
    case "playSound":
      return oneArgumentStatement(args, context, node, (file) => ({ kind: "playAudio", file, async: false, repeatCount: null, span }));
    case "playBackgroundSound":
      return lowerBackgroundSound(args, node, span, context);
    case "save":
      return lowerSave(args, node, span, context);
    case "exit":
      if (args.length !== 0) return [unsupportedStatement(context, node, "SX_EXIT_ARITY", "exit() must have no arguments.")];
      return [{ kind: "exit", span }];
    default: {
      const expression = lowerExpression(node, context);
      return expression === null
        ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_CALL", `Unsupported SexScript call: ${call.name}`)]
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
    return [unsupportedStatement(context, node, "SX_EACH_SHAPE", "Groovy each() needs one inline closure for automatic migration.")];
  }
  if (receiverNode.kind !== "range" && !isKnownListExpression(receiverNode, context)) {
    return [unsupportedStatement(
      context,
      node,
      "SX_EACH_RECEIVER",
      "Groovy each() is migrated automatically only for a proven list or numeric range receiver.",
    )];
  }

  const closure = args[0];
  const body = asNode(closure.body);
  if (body?.kind !== "block") {
    return [unsupportedStatement(context, node, "SX_EACH_BODY", "Groovy each() closure does not contain a normal block body.")];
  }
  if (containsReturnForCurrentClosure(body)) {
    return [unsupportedStatement(
      context,
      node,
      "SX_EACH_RETURN",
      "Groovy return inside each() returns from the closure and needs a dedicated control-flow rewrite.",
    )];
  }

  const parameterSpecified = closure.parameterSpecified === true;
  const rawParameters = Array.isArray(closure.parameters) ? closure.parameters : [];
  if (parameterSpecified && rawParameters.length !== 1) {
    return [unsupportedStatement(context, node, "SX_EACH_PARAMETERS", "Only one-parameter list/range each() closures are migrated automatically.")];
  }
  let variable = "it";
  if (parameterSpecified) {
    const raw = rawParameters[0];
    if (typeof raw !== "object" || raw === null || typeof (raw as Record<string, unknown>).name !== "string") {
      return [unsupportedStatement(context, node, "SX_EACH_PARAMETERS", "Groovy each() closure parameter is invalid.")];
    }
    variable = String((raw as Record<string, unknown>).name);
  }

  const collection = lowerExpression(receiverNode, context);
  if (collection === null) {
    return [unsupportedStatement(context, node, "SX_EACH_RECEIVER", "Groovy each() receiver could not be migrated safely.")];
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

function lowerBackgroundSound(args: AstNode[], node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  if (args.length < 1 || args.length > 2 || isNullConstant(args[0])) {
    return [unsupportedStatement(context, node, "SX_BACKGROUND_SOUND_CONTROL", "Null/global stop behavior for background sound needs manual migration.")];
  }
  const file = lowerExpression(args[0]!, context);
  const repeatCount = args[1] === undefined ? null : lowerExpression(args[1], context);
  if (file === null || (args[1] !== undefined && repeatCount === null)) {
    return [unsupportedStatement(context, node, "SX_BACKGROUND_SOUND_ARGUMENT", "Background sound arguments could not be migrated.")];
  }
  return [{ kind: "playAudio", file, async: true, repeatCount, span }];
}

function lowerSave(args: AstNode[], node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  if (args.length !== 2) return [unsupportedStatement(context, node, "SX_SAVE_ARITY", "save() must have exactly two arguments.")];
  const key = lowerExpression(args[0]!, context);
  if (key === null) return [unsupportedStatement(context, node, "SX_SAVE_ARGUMENT", "save() key could not be migrated.")];
  if (isNullConstant(args[1])) return [{ kind: "delete", key, span }];
  const value = lowerExpression(args[1]!, context);
  if (value === null) return [unsupportedStatement(context, node, "SX_SAVE_ARGUMENT", "save() value could not be migrated.")];
  return [{ kind: "save", key, value, span }];
}

function lowerIf(node: AstNode, context: LowerContext): IrStatement[] {
  const conditionNode = asNode(node.condition);
  const thenNode = asNode(node.then);
  const elseNode = asNode(node.else);
  const condition = conditionNode === null ? null : lowerExpression(conditionNode, context);
  if (condition === null || thenNode === null || thenNode.kind === "empty") {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_IF", "if condition or body could not be migrated safely.")];
  }
  return [{
    kind: "if",
    condition,
    then: lowerBranch(thenNode, context),
    else: elseNode === null ? [] : lowerBranch(elseNode, context),
    span: node.span,
  }];
}

function lowerBranch(node: AstNode, context: LowerContext): IrStatement[] {
  if (node.kind === "empty") return [];
  return node.kind === "block" ? lowerBlock(node, context) : lowerStatement(node, context);
}

function lowerWhile(node: AstNode, context: LowerContext): IrStatement[] {
  const conditionNode = asNode(node.condition);
  const body = asNode(node.body);
  const condition = conditionNode === null ? null : lowerExpression(conditionNode, context);
  if (condition === null || body?.kind !== "block") {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_WHILE", "while condition or body could not be migrated safely.")];
  }
  return [{ kind: "while", condition, body: lowerBlock(body, context), span: node.span }];
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
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_FOR", "for loop could not be migrated safely.")];
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
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_FOR", "C-style for loop shape is not supported.")];
  }
  if (containsContinueForCurrentLoop(body)) {
    return [unsupportedStatement(
      context,
      node,
      "SX_C_STYLE_CONTINUE",
      "C-style for loop contains continue; its update step must run before continuing, so this loop needs a dedicated rewrite.",
    )];
  }

  const [initial, conditionNode, update] = parts as [AstNode, AstNode, AstNode];
  const initialStatements = lowerForControlExpression(initial, context);
  const condition = lowerExpression(conditionNode, context);
  const updateStatements = lowerForControlExpression(update, context);
  if (condition === null || initialStatements === null || updateStatements === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_FOR", "C-style for loop control expressions could not be migrated safely.")];
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
  if (value === null) return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_VALUE", "switch value could not be migrated.")];

  const caseNodes = nodeArray(node.cases);
  const defaultNode = asNode(node.default);
  const defaultSource = switchBodyStatements(defaultNode);
  if (defaultSource === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_CASE", "Switch default body could not be migrated safely.")];
  }

  const cases: IrSwitchCase[] = [];
  for (let index = 0; index < caseNodes.length; index += 1) {
    const caseNode = caseNodes[index]!;
    if (caseNode.kind !== "case") return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_CASE", "Unexpected Groovy switch case node.")];
    const matchNode = asNode(caseNode.expression);
    const match = matchNode === null ? null : lowerExpression(matchNode, context);
    if (match === null) {
      return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_CASE", "Switch case could not be migrated safely.")];
    }
    const sourceStatements = collectSwitchPath(caseNodes, index, defaultSource);
    if (sourceStatements === null) {
      return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_CASE", "Switch case body could not be migrated safely.")];
    }
    const loweredBody: IrStatement[] = [];
    for (const statement of sourceStatements) loweredBody.push(...lowerStatement(statement, context));
    cases.push({ span: caseNode.span, match, body: loweredBody });
  }

  const defaultStatements: IrStatement[] = [];
  for (const statement of withoutTerminalBreak(defaultSource)) defaultStatements.push(...lowerStatement(statement, context));
  return [{ kind: "switch", value, cases, default: defaultStatements, span: node.span }];
}

function collectSwitchPath(caseNodes: AstNode[], start: number, defaultSource: AstNode[]): AstNode[] | null {
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
      return [unsupportedStatement(context, node, "SX_UNSUPPORTED_FUNCTION_RETURN", "Function return value could not be migrated.")];
    }
    return [{ kind: "return", value, span: node.span }];
  }

  if (valueNode === null || isNullConstant(valueNode)) return [{ kind: "end", span: node.span }];
  const script = lowerExpression(valueNode, context);
  if (script === null) return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SCRIPT_RETURN", "Script return value could not be migrated.")];
  if (script.kind === "literal" && typeof script.value === "string") script.value = migrateScriptPath(script.value);
  return [{ kind: "run", script, span: node.span }];
}

function lowerExpression(node: AstNode, context: LowerContext): IrExpression | null {
  switch (node.kind) {
    case "constant":
      return isLiteral(node.value) ? { kind: "literal", value: node.value } : unsupportedExpression(context, node, "SX_UNSUPPORTED_CONSTANT", "Unsupported Groovy constant value.");
    case "variable": {
      const name = variableName(node);
      if (name === null) return unsupportedExpression(context, node, "SX_INVALID_VARIABLE", "Variable is missing a name.");
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
    case "not":
      return lowerUnary(node, "not", context);
    case "unaryMinus":
      return lowerUnary(node, "-", context);
    case "unaryPlus":
      return lowerUnary(node, "+", context);
    case "methodCall":
      return lowerMethodCallExpression(node, context);
    default:
      return unsupportedExpression(context, node, "SX_UNSUPPORTED_EXPRESSION", `Unsupported Groovy expression: ${node.kind}`);
  }
}


function lowerMapExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const properties: Array<{ name: string; value: IrExpression }> = [];
  for (const entry of nodeArray(node.entries)) {
    if (entry.kind !== "mapEntry") {
      return unsupportedExpression(context, node, "SX_MAP_ENTRY", "Groovy map contains an invalid entry.");
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
  const mapped = operator === "&&" ? "and" : operator === "||" ? "or" : operator;
  if (mapped === null || !new Set(["==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "and", "or"]).has(mapped)) {
    return unsupportedExpression(context, node, "SX_UNSUPPORTED_OPERATOR", `Groovy operator ${operator ?? "?"} is not safely mapped yet.`);
  }
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  const left = leftNode === null ? null : lowerExpression(leftNode, context);
  const right = rightNode === null ? null : lowerExpression(rightNode, context);
  return left === null || right === null ? null : { kind: "binary", operator: mapped, left, right };
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
      return value.kind === "list" ? value : unsupportedExpression(context, node, "SX_UNSUPPORTED_CAST", "Only literal-list List casts are erased safely.");
    default:
      return unsupportedExpression(context, node, "SX_UNSUPPORTED_CAST", `Groovy cast to ${text(node.type) ?? "unknown"} is not mapped.`);
  }
}

function lowerUnary(node: AstNode, operator: "not" | "+" | "-", context: LowerContext): IrExpression | null {
  const valueNode = asNode(node.value);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  return value === null ? null : { kind: "unary", operator, value };
}

function lowerPropertyExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const targetNode = asNode(node.object);
  const property = constantString(node.property);
  if (targetNode === null || property === null) {
    return unsupportedExpression(context, node, "SX_DYNAMIC_PROPERTY", "Dynamic Groovy property access is not lowered automatically.");
  }
  if (property === "size" && isKnownListExpression(targetNode, context)) {
    const target = lowerExpression(targetNode, context);
    return target === null ? null : { kind: "property", target, name: "length" };
  }
  return unsupportedExpression(context, node, "SX_UNSUPPORTED_PROPERTY", `Groovy property .${property} is not safely mapped for this receiver.`);
}

function lowerObjectMethodCallExpression(
  node: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null {
  const targetNode = asNode(node.object);
  const receiverName = targetNode === null ? null : variableName(targetNode);
  const helperClass = receiverName === null ? undefined : context.legacyHelperClasses.get(receiverName);
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
    if (name === "round") {
      return unsupportedExpression(
        context,
        node,
        "SX_ROUNDING_SEMANTICS",
        "Java Math.round() is not migrated until its tie-breaking semantics are proven equivalent to TeaseScript round().",
      );
    }
  }
  if (receiverName === "System" && name === "exit") {
    return unsupportedExpression(
      context,
      node,
      "SX_JVM_PROCESS_CONTROL",
      "System.exit() terminates the legacy JVM process and is not automatically equivalent to TeaseScript exit.",
    );
  }
  if (name === "get" && targetNode?.kind === "methodCall") {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_REFLECTION",
      "Java/reflection call chains are not reproduced by the TeaseScript importer.",
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
    return unsupportedExpression(context, node, "SX_DYNAMIC_OR_OBJECT_CALL", "Object/dynamic Groovy method calls are not lowered by the first slice.");
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
    return { kind: "call", name: "sexscriptLegacyIndexOf", positional: [target, args[0]!], named: {} };
  }
  return unsupportedExpression(context, node, "SX_UNSUPPORTED_LIST_METHOD", `Groovy list method ${name}() is not safely mapped yet.`);
}

function isKnownListExpression(node: AstNode, context: LowerContext): boolean {
  if (node.kind === "list") return true;
  const name = variableName(node);
  return name !== null && context.listVariables.has(name);
}

function lowerMethodCallExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const call = callParts(node);
  if (call === null) {
    return unsupportedExpression(context, node, "SX_DYNAMIC_OR_OBJECT_CALL", "Dynamic Groovy method names are not lowered by the first slice.");
  }
  if (!call.inherited) return lowerObjectMethodCallExpression(node, call.name, call.arguments, context);
  const helperInfo = context.helperFunctions.get(call.name);
  if (helperInfo !== undefined) {
    let argumentNodes = call.arguments;
    if (helperInfo.stripsMain) {
      if (context.helperMainParameter === null || variableName(argumentNodes[0]) !== context.helperMainParameter) {
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
    if (call.arguments.length < functionInfo.minArgs || call.arguments.length > functionInfo.maxArgs) {
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
  if (context.helperMainParameter !== null && variableName(node.object) !== context.helperMainParameter) {
    return unsupportedExpression(
      context,
      node,
      "SX_HELPER_UNQUALIFIED_CALL",
      `Unqualified Groovy helper call ${call.name}() is not assumed to be a SexScript host API.`,
    );
  }
  if (DIRECT_STORAGE_LOADS.has(call.name)) {
    if (call.arguments.length !== 1) {
      return unsupportedExpression(context, node, "SX_STORAGE_LOAD_ARITY", `${call.name}() must have exactly one key argument.`);
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
      if (args.length !== 1) return unsupportedExpression(context, node, "SX_RANDOM_ARITY", "getRandom() must have one argument.");
      return {
        kind: "call",
        name: "randomInteger",
        positional: [{ kind: "range", from: { kind: "literal", value: 0 }, to: args[0]!, inclusive: false }],
        named: {},
      };
    case "getTime":
      return args.length === 0
        ? { kind: "call", name: "getSeconds", positional: [], named: {} }
        : unsupportedExpression(context, node, "SX_TIME_ARITY", "getTime() must have no arguments.");
    case "getBoolean":
      if (args.length === 1) return { kind: "call", name: "askBoolean", positional: args, named: {} };
      if (args.length === 3) return { kind: "call", name: "askBoolean", positional: [], named: { message: args[0]!, yesText: args[1]!, noText: args[2]! } };
      return unsupportedExpression(context, node, "SX_BOOLEAN_ARITY", "getBoolean() must have one or three arguments.");
    case "showButton":
      return args.length === 1 || args.length === 2
        ? { kind: "call", name: "showButton", positional: args, named: {} }
        : unsupportedExpression(context, node, "SX_BUTTON_ARITY", "showButton() must have one or two arguments.");
    case "useUrl":
      return args.length === 1
        ? { kind: "call", name: "openUrl", positional: args, named: {} }
        : unsupportedExpression(context, node, "SX_URL_ARITY", "useUrl() must have one argument.");
    case "getString":
    case "getInteger":
    case "getFloat":
      return unsupportedExpression(context, node, "SX_INPUT_DEFAULT_SEMANTICS", `${call.name}() has a pre-filled default value that the accepted TeaseScript input contract does not currently preserve.`);
    case "getSelectedValue":
      return lowerSelectedValue(node, call.arguments, context);
    default:
      return unsupportedExpression(context, node, "SX_UNSUPPORTED_SEXSCRIPT_EXPRESSION", `Unsupported SexScript expression call: ${call.name}`);
  }
}

function lowerSelectedValue(node: AstNode, args: AstNode[], context: LowerContext): IrExpression | null {
  if (args.length !== 2) {
    return unsupportedExpression(context, node, "SX_CHOICE_ARITY", "getSelectedValue() must have exactly two arguments.");
  }
  const message = lowerExpression(args[0]!, context);
  if (message === null) return null;
  const optionsNode = args[1]!;
  if (optionsNode.kind !== "list") {
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_CHOICE_OPTIONS",
      "Dynamic getSelectedValue() option lists need a separate migration strategy.",
    );
  }
  const options: IrExpression[] = [];
  for (const item of nodeArray(optionsNode.items)) {
    const option = lowerExpression(item, context);
    if (option === null) return null;
    options.push(option);
  }
  if (options.length === 0) {
    return unsupportedExpression(context, node, "SX_EMPTY_CHOICE", "getSelectedValue() has no choices.");
  }
  return { kind: "choice", message, options };
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
  if (args.length !== 1) return [unsupportedStatement(context, node, "SX_CALL_ARITY", "Expected one argument.")];
  const value = lowerExpression(args[0]!, context);
  return value === null ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_ARGUMENT", "Argument could not be migrated.")] : [build(value)];
}

function extractMetadata(args: AstNode[], context: LowerContext, span: SourceSpan | null): void {
  if (args.length !== 8) {
    addDiagnostic(context, "SX_METADATA_DYNAMIC", "warning", "setInfos() metadata could not be extracted statically.", span);
    return;
  }
  const values = args.map(constantValue);
  const tagsNode = args[7];
  const tags = tagsNode?.kind === "list" ? nodeArray(tagsNode.items).map(constantString) : [];
  const tagsValid = tagsNode?.kind === "list" && tags.every((tag) => tag !== null);
  if (values.slice(0, 7).some((value) => value === undefined) || !tagsValid) {
    addDiagnostic(context, "SX_METADATA_DYNAMIC", "warning", "setInfos() metadata could not be extracted statically.", span);
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
    tags: tags as string[],
  };
}

function callParts(node: AstNode): { name: string; inherited: boolean; arguments: AstNode[] } | null {
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
    if (name !== null && value !== null && isGroovyClassLoaderConstructor(value)) classLoaders.add(name);
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

function collectListVariables(body: AstNode): Set<string> {
  const assignments = new Map<string, AstNode[]>();
  const add = (name: string, value: AstNode): void => {
    const current = assignments.get(name);
    if (current === undefined) assignments.set(name, [value]);
    else current.push(value);
  };

  walkAst(body, (node) => {
    if (node.kind === "declaration") {
      const name = variableName(node.left);
      const value = asNode(node.right);
      if (name !== null && value !== null) add(name, value);
      return;
    }
    if (node.kind === "binary" && node.operator === "=") {
      const name = variableName(node.left);
      const value = asNode(node.right);
      if (name !== null && value !== null) add(name, value);
    }
  });

  const known = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, values] of assignments) {
      if (known.has(name)) continue;
      let evidence = false;
      let valid = true;
      for (const value of values) {
        if (isEmptyGroovyExpression(value)) continue;
        if (expressionProvesList(value, name, known)) {
          evidence = true;
          continue;
        }
        valid = false;
        break;
      }
      if (valid && evidence) {
        known.add(name);
        changed = true;
      }
    }
  }
  return known;
}

function expressionProvesList(node: AstNode, selfName: string, known: Set<string>): boolean {
  if (node.kind === "list") return true;
  if (node.kind === "cast" && (node.type === "List" || node.type === "java.util.List")) {
    const value = asNode(node.value);
    return value !== null && expressionProvesList(value, selfName, known);
  }
  if (node.kind === "variable") {
    const name = variableName(node);
    return name !== null && known.has(name);
  }
  if (node.kind === "binary" && node.operator === "+") {
    const left = asNode(node.left);
    const right = asNode(node.right);
    if (left === null || right === null) return false;
    const leftIsSelf = variableName(left) === selfName;
    return (leftIsSelf || expressionProvesList(left, selfName, known)) && expressionProvesList(right, selfName, known);
  }
  return false;
}

function isEmptyGroovyExpression(node: AstNode): boolean {
  return node.kind === "unsupportedExpression" && node.groovyType === "org.codehaus.groovy.ast.expr.EmptyExpression";
}

function collectClosureInfo(body: AstNode): Map<string, ClosureInfo> {
  const result = new Map<string, ClosureInfo>();
  for (const statement of nodeArray(body.statements)) {
    const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    if (expression?.kind !== "declaration") continue;
    const name = variableName(expression.left);
    const closure = asNode(expression.right);
    if (name === null || closure?.kind !== "closure") continue;
    const implicitParameter = closure.parameterSpecified !== true;
    const parameters = Array.isArray(closure.parameters) ? closure.parameters : [];
    let minArgs = 0;
    if (!implicitParameter) {
      minArgs = parameters.filter((parameter) => {
        if (typeof parameter !== "object" || parameter === null) return true;
        return (parameter as Record<string, unknown>).default === null;
      }).length;
    }
    result.set(name, { implicitParameter, minArgs, maxArgs: implicitParameter ? 0 : parameters.length });
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
  return result;
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
          { kind: "let", name: "value", value: { kind: "load", key: { kind: "variable", name: "key" } }, span: null },
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

function unsupportedExpression(context: LowerContext, node: AstNode, code: string, message: string): null {
  addDiagnostic(context, code, "error", message, node.span);
  return null;
}

function unsupportedStatement(context: LowerContext, node: AstNode, code: string, message: string): IrStatement {
  addDiagnostic(context, code, "error", message, node.span);
  return { kind: "unsupported", diagnosticCode: code, summary: message, span: node.span };
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
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function constantValue(node: AstNode | undefined): unknown | undefined {
  return node?.kind === "constant" ? node.value : undefined;
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
