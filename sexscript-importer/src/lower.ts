import { constantString, isAstNode, variableName, type AstNode, type ParsedGroovyFile, type SourceSpan } from "./ast.ts";
import type {
  IrExpression,
  IrStatement,
  IrSwitchCase,
  LegacyMetadata,
  MigrationDiagnostic,
  MigrationProgram,
} from "./ir.ts";

interface LowerContext {
  diagnostics: MigrationDiagnostic[];
  metadata: LegacyMetadata | null;
}

const STORAGE_LOADS = new Set([
  "load",
  "loadBoolean",
  "loadFloat",
  "loadInteger",
  "loadMap",
  "loadString",
  "loadFirstTrue",
]);

export function lowerParsedFile(file: ParsedGroovyFile): MigrationProgram {
  const context: LowerContext = { diagnostics: [], metadata: null };
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

  if (file.root.kind !== "scriptBody") {
    context.diagnostics.push({
      code: "SX_UNIT_LOWERING_DEFERRED",
      severity: "error",
      message: "Auxiliary Groovy classes are parsed but not lowered by the first script-body slice.",
      span: file.root.span,
    });
    return { sourceName: file.sourceName, metadata: null, statements: [], diagnostics: context.diagnostics };
  }

  const body = asNode(file.root.body);
  const statements = body?.kind === "block" ? lowerBlock(body, context) : [];
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
      return lowerScriptReturn(node, context);
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
  const value = lowerExpression(right, context);
  if (value === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_DECLARATION_VALUE", `Cannot safely migrate initializer for ${name}.`)];
  }
  return [{ kind: "let", name, value, span }];
}

function lowerAssignment(node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  const operator = text(node.operator);
  if (operator !== "=" && operator !== "+=" && operator !== "-=") {
    const lowered = lowerExpression(node, context);
    return lowered === null
      ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_BINARY_STATEMENT", `Unsupported binary statement operator ${operator ?? "?"}.`)]
      : [{ kind: "expression", expression: lowered, span }];
  }
  const target = variableName(node.left);
  const right = asNode(node.right);
  if (target === null || right === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_ASSIGNMENT_TARGET", "The first slice only assigns to local variables.")];
  }
  const value = lowerExpression(right, context);
  if (value === null) {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_ASSIGNMENT_VALUE", `Cannot safely migrate assignment to ${target}.`)];
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
    target,
    operator: operator === "++" ? "+=" : "-=",
    value: { kind: "literal", value: 1 },
    span,
  }];
}

function lowerCallStatement(node: AstNode, span: SourceSpan | null, context: LowerContext): IrStatement[] {
  const call = callParts(node);
  if (call === null || !call.inherited) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [unsupportedStatement(context, node, "SX_UNSUPPORTED_CALL", "Method call is not a supported SexScript call.")]
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
      return oneArgumentStatement(args, context, node, (duration) => ({ kind: "wait", duration, visible: false, span }));
    case "waitWithGauge":
      return oneArgumentStatement(args, context, node, (duration) => ({ kind: "wait", duration, visible: true, span }));
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
  if (condition === null || thenNode?.kind !== "block") {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_IF", "if condition or body could not be migrated safely.")];
  }
  const elseStatements = elseNode === null || elseNode.kind === "empty"
    ? []
    : elseNode.kind === "block"
      ? lowerBlock(elseNode, context)
      : lowerStatement(elseNode, context);
  return [{ kind: "if", condition, then: lowerBlock(thenNode, context), else: elseStatements, span: node.span }];
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
  const collection = collectionNode === null ? null : lowerExpression(collectionNode, context);
  if (variable === null || collection === null || body?.kind !== "block") {
    return [unsupportedStatement(context, node, "SX_UNSUPPORTED_FOR", "for loop could not be migrated safely.")];
  }
  return [{ kind: "for", variable, collection, body: lowerBlock(body, context), span: node.span }];
}

function lowerSwitch(node: AstNode, context: LowerContext): IrStatement[] {
  const valueNode = asNode(node.expression);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  if (value === null) return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_VALUE", "switch value could not be migrated.")];

  const cases: IrSwitchCase[] = [];
  for (const caseNode of nodeArray(node.cases)) {
    if (caseNode.kind !== "case") return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_CASE", "Unexpected Groovy switch case node.")];
    const matchNode = asNode(caseNode.expression);
    const bodyNode = asNode(caseNode.body);
    const match = matchNode === null ? null : lowerExpression(matchNode, context);
    if (match === null || bodyNode?.kind !== "block") {
      return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SWITCH_CASE", "Switch case could not be migrated safely.")];
    }
    const sourceStatements = nodeArray(bodyNode.statements);
    const terminalBreak = sourceStatements.at(-1)?.kind === "break";
    const terminalReturn = sourceStatements.at(-1)?.kind === "return";
    if (!terminalBreak && !terminalReturn) {
      addDiagnostic(context, "SX_SWITCH_FALLTHROUGH", "error", "Groovy switch fallthrough is not equivalent to TeaseScript switch semantics.", caseNode.span);
      return [{ kind: "unsupported", diagnosticCode: "SX_SWITCH_FALLTHROUGH", summary: "Switch with possible fallthrough requires manual migration.", span: node.span }];
    }
    const loweredBody: IrStatement[] = [];
    for (const statement of terminalBreak ? sourceStatements.slice(0, -1) : sourceStatements) {
      loweredBody.push(...lowerStatement(statement, context));
    }
    cases.push({ span: caseNode.span, match, body: loweredBody });
  }

  const defaultNode = asNode(node.default);
  let defaultStatements: IrStatement[] = [];
  if (defaultNode !== null && defaultNode.kind !== "empty") {
    defaultStatements = defaultNode.kind === "block" ? lowerBlock(defaultNode, context) : lowerStatement(defaultNode, context);
    if (defaultStatements.at(-1)?.kind === "break") defaultStatements.pop();
  }
  return [{ kind: "switch", value, cases, default: defaultStatements, span: node.span }];
}

function lowerScriptReturn(node: AstNode, context: LowerContext): IrStatement[] {
  const valueNode = asNode(node.value);
  if (valueNode === null || isNullConstant(valueNode)) return [{ kind: "end", span: node.span }];
  const script = lowerExpression(valueNode, context);
  if (script === null) return [unsupportedStatement(context, node, "SX_UNSUPPORTED_SCRIPT_RETURN", "Script return value could not be migrated.")];
  if (script.kind === "literal" && typeof script.value === "string") {
    script.value = migrateScriptPath(script.value);
  }
  return [{ kind: "run", script, span: node.span }];
}

function lowerExpression(node: AstNode, context: LowerContext): IrExpression | null {
  switch (node.kind) {
    case "constant":
      return isLiteral(node.value) ? { kind: "literal", value: node.value } : unsupportedExpression(context, node, "SX_UNSUPPORTED_CONSTANT", "Unsupported Groovy constant value.");
    case "variable": {
      const name = variableName(node);
      return name === null ? unsupportedExpression(context, node, "SX_INVALID_VARIABLE", "Variable is missing a name.") : { kind: "variable", name };
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

function lowerBinaryExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const operator = text(node.operator);
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

function lowerUnary(node: AstNode, operator: "not" | "+" | "-", context: LowerContext): IrExpression | null {
  const valueNode = asNode(node.value);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  return value === null ? null : { kind: "unary", operator, value };
}

function lowerMethodCallExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const call = callParts(node);
  if (call === null || !call.inherited) {
    return unsupportedExpression(context, node, "SX_DYNAMIC_OR_OBJECT_CALL", "Object/dynamic Groovy method calls are not lowered by the first slice.");
  }
  if (STORAGE_LOADS.has(call.name)) {
    return unsupportedExpression(
      context,
      node,
      "SX_STORAGE_MISSING_KEY_SEMANTICS",
      `${call.name}() returns null for a missing legacy key, while TeaseScript load requires and stores a default.`,
    );
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
      return unsupportedExpression(context, node, "SX_CHOICE_STATEMENT_REWRITE", "getSelectedValue() needs a statement-level rewrite to preserve its zero-based result and question text.");
    default:
      return unsupportedExpression(context, node, "SX_UNSUPPORTED_SEXSCRIPT_EXPRESSION", `Unsupported SexScript expression call: ${call.name}`);
  }
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
