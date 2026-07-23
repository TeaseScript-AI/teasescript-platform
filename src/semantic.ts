import type {
  AssignmentTarget,
  Block,
  Expression,
  FunctionDeclaration,
  Program,
  Statement,
} from "./ast.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import type { SourceSpan } from "./source.js";

export interface SemanticValidationOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
}

export interface SemanticValidationResult {
  readonly diagnostics: readonly Diagnostic[];
}

type BindingKind = "variable" | "speaker" | "global" | "function";

interface Binding {
  readonly kind: BindingKind;
}

const semanticCode = {
  duplicateDeclaration: "TSV001",
  unknownVariable: "TSV002",
  unknownAssignment: "TSV003",
  invalidAssignment: "TSV004",
  unknownSpeaker: "TSV005",
  invalidSetElement: "TSV006",
  duplicateProperty: "TSV007",
  invalidLoopControl: "TSV008",
  chainedRange: "TSV009",
  invalidRangeOperand: "TSV010",
  invalidRepeatCount: "TSV011",
  invalidLoopSource: "TSV012",
  duplicateFunction: "TSV013",
  duplicateParameter: "TSV014",
  requiredAfterDefault: "TSV015",
  nestedFunction: "TSV016",
  returnOutsideFunction: "TSV017",
  unknownFunction: "TSV018",
  nonCallable: "TSV019",
  argumentCount: "TSV020",
  mixedArguments: "TSV021",
  unknownNamedArgument: "TSV022",
  duplicateNamedArgument: "TSV023",
  missingNamedArgument: "TSV024",
  laterParameterDefault: "TSV025",
  functionAssignment: "TSV026",
  unsupportedFunctionAnnotation: "TSV027",
  functionValue: "TSV028",
} as const;

const coreBuiltinNames = Object.freeze([
  "random",
  "chance",
  "randomInteger",
] as const);

export function validateSemantics(
  program: Program,
  options: SemanticValidationOptions = {},
): SemanticValidationResult {
  const validator = new SemanticValidator(options);
  validator.validate(program);
  return Object.freeze({ diagnostics: Object.freeze([...validator.diagnostics]) });
}

class SemanticScope {
  readonly bindings = new Map<string, Binding>();

  public constructor(readonly parent: SemanticScope | null = null) {}

  public resolve(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.resolve(name);
  }

  public declare(name: string, binding: Binding): boolean {
    if (this.resolve(name) !== undefined) return false;
    this.bindings.set(name, binding);
    return true;
  }
}

class SemanticValidator {
  readonly diagnostics: Diagnostic[] = [];
  readonly #builtins: ReadonlySet<string>;
  readonly #root = new SemanticScope();
  readonly #functions = new Map<string, FunctionDeclaration>();
  #functionDepth = 0;

  public constructor(options: SemanticValidationOptions) {
    this.#builtins = new Set([
      ...coreBuiltinNames,
      ...(options.builtins ?? []),
    ]);
    for (const name of options.globals ?? []) {
      this.#root.declare(name, { kind: "global" });
    }
  }

  public validate(program: Program): void {
    for (const statement of program.statements) {
      if (statement.kind !== "functionDeclaration") continue;
      if (this.#functions.has(statement.name.name)) {
        this.#report(
          semanticCode.duplicateFunction,
          `Duplicate function declaration '${statement.name.name}'.`,
          statement.name.span,
        );
        continue;
      }
      if (this.#declare(statement.name.name, "function", statement.name.span, this.#root)) {
        this.#functions.set(statement.name.name, statement);
      }
    }
    for (const statement of program.statements) {
      if (statement.kind !== "functionDeclaration") {
        this.#validateStatement(statement, this.#root, 0);
      }
    }
    for (const statement of program.statements) {
      if (
        statement.kind === "functionDeclaration" &&
        this.#functions.get(statement.name.name) === statement
      ) {
        this.#validateFunction(statement);
      }
    }
  }

  #validateStatements(
    statements: readonly Statement[],
    scope: SemanticScope,
    loopDepth: number,
  ): void {
    for (const statement of statements) {
      this.#validateStatement(statement, scope, loopDepth);
    }
  }

  #validateStatement(
    statement: Statement,
    scope: SemanticScope,
    loopDepth: number,
  ): void {
    switch (statement.kind) {
      case "letStatement":
        this.#validateExpression(statement.initializer, scope, null);
        this.#declare(statement.name.name, "variable", statement.name.span, scope);
        return;
      case "speakerDeclaration": {
        const declared = this.#declare(
          statement.name.name,
          "speaker",
          statement.name.span,
          scope,
        );
        const names = new Set<string>();
        for (const property of statement.properties) {
          if (names.has(property.name.name)) {
            this.#report(
              semanticCode.duplicateProperty,
              `Duplicate speaker property '${property.name.name}'.`,
              property.name.span,
            );
          }
          names.add(property.name.name);
          this.#validateExpression(
            property.value,
            scope,
            declared ? statement.name.name : null,
          );
        }
        return;
      }
      case "speakerSetterStatement":
        this.#validateSpeakerReference(statement.speaker.name, statement.speaker.span, scope);
        return;
      case "sayStatement": {
        const contextualSpeaker =
          statement.speaker === null
            ? "speaker"
            : this.#validateSpeakerReference(
                statement.speaker.name,
                statement.speaker.span,
                scope,
              )
              ? statement.speaker.name
              : null;
        this.#validateExpression(statement.value, scope, contextualSpeaker);
        return;
      }
      case "assignmentStatement":
        this.#validateAssignmentTarget(statement.target, scope);
        this.#validateExpression(statement.value, scope, null);
        return;
      case "expressionStatement":
        this.#validateExpression(statement.expression, scope, null);
        return;
      case "ifStatement":
        this.#validateExpression(statement.condition, scope, null);
        this.#validateBlock(statement.thenBlock, scope, loopDepth);
        if (statement.elseBlock !== null) {
          if (statement.elseBlock.kind === "ifStatement") {
            this.#validateStatement(statement.elseBlock, scope, loopDepth);
          } else {
            this.#validateBlock(statement.elseBlock, scope, loopDepth);
          }
        }
        return;
      case "repeatStatement":
        this.#validateExpression(statement.count, scope, null);
        const knownCount = knownNumber(statement.count);
        if (
          knownCount !== undefined &&
          (!Number.isInteger(knownCount) || knownCount < 0)
        ) {
          this.#report(
            semanticCode.invalidRepeatCount,
            "A statically known repeat count must be a non-negative integer.",
            statement.count.span,
          );
        } else if (isDefinitelyNonNumeric(statement.count)) {
          this.#report(
            semanticCode.invalidRepeatCount,
            "A repeat count must be an integer value.",
            statement.count.span,
          );
        }
        this.#validateBlock(statement.body, scope, loopDepth + 1);
        return;
      case "forStatement": {
        this.#validateExpression(statement.iterable, scope, null);
        if (isDefinitelyNonIterable(statement.iterable)) {
          this.#report(
            semanticCode.invalidLoopSource,
            "A for-loop source must be a list, set, or integer range.",
            statement.iterable.span,
          );
        }
        if (
          statement.iterable.kind === "rangeExpression" &&
          (!isKnownInteger(statement.iterable.start) ||
            !isKnownInteger(statement.iterable.end))
        ) {
          this.#report(
            semanticCode.invalidRangeOperand,
            "A statically known iterated range must have integer bounds.",
            statement.iterable.span,
          );
        }
        const loopScope = new SemanticScope(scope);
        this.#declare(
          statement.variable.name,
          "variable",
          statement.variable.span,
          loopScope,
        );
        this.#validateStatements(statement.body.statements, loopScope, loopDepth + 1);
        return;
      }
      case "whileStatement":
        this.#validateExpression(statement.condition, scope, null);
        this.#validateBlock(statement.body, scope, loopDepth + 1);
        return;
      case "breakStatement":
      case "continueStatement":
        if (loopDepth === 0) {
          this.#report(
            semanticCode.invalidLoopControl,
            `'${statement.kind === "breakStatement" ? "break" : "continue"}' may only appear inside a loop.`,
            statement.span,
          );
        }
        return;
      case "functionDeclaration":
        this.#report(
          semanticCode.nestedFunction,
          "Nested function declarations are not supported in this milestone.",
          statement.span,
        );
        return;
      case "returnStatement":
        if (this.#functionDepth === 0) {
          this.#report(
            semanticCode.returnOutsideFunction,
            "'return' may only appear inside a function.",
            statement.span,
          );
        }
        if (statement.value !== null) {
          this.#validateExpression(statement.value, scope, null);
        }
        return;
      case "exitStatement":
        return;
    }
  }

  #validateFunction(declaration: FunctionDeclaration): void {
    if (declaration.returnTypeAnnotation !== null) {
      this.#report(
        semanticCode.unsupportedFunctionAnnotation,
        "Function return-type annotations are parsed but not implemented in this milestone.",
        declaration.returnTypeAnnotation.span,
      );
    }
    const names = new Set<string>();
    let sawDefault = false;
    const bodyScope = new SemanticScope(this.#root);
    for (const parameter of declaration.parameters) {
      const duplicate = names.has(parameter.name.name);
      if (duplicate) {
        this.#report(
          semanticCode.duplicateParameter,
          `Duplicate function parameter '${parameter.name.name}'.`,
          parameter.name.span,
        );
      }
      names.add(parameter.name.name);
      if (parameter.typeAnnotation !== null) {
        this.#report(
          semanticCode.unsupportedFunctionAnnotation,
          "Function parameter annotations are parsed but not implemented in this milestone.",
          parameter.typeAnnotation.span,
        );
      }
      if (parameter.defaultValue === null && sawDefault) {
        this.#report(
          semanticCode.requiredAfterDefault,
          "Required parameters must precede parameters with defaults.",
          parameter.span,
        );
      }
      sawDefault ||= parameter.defaultValue !== null;
      if (!duplicate) {
        this.#declare(parameter.name.name, "variable", parameter.name.span, bodyScope);
      }
    }

    const defaultScope = new SemanticScope(this.#root);
    for (let index = 0; index < declaration.parameters.length; index += 1) {
      const parameter = declaration.parameters[index]!;
      if (parameter.defaultValue !== null) {
        const laterNames = new Set(
          declaration.parameters.slice(index + 1).map((item) => item.name.name),
        );
        this.#reportLaterParameterReferences(parameter.defaultValue, laterNames);
        this.#validateExpression(parameter.defaultValue, defaultScope, null);
      }
      defaultScope.declare(parameter.name.name, { kind: "variable" });
    }

    this.#functionDepth += 1;
    try {
      this.#validateStatements(declaration.body.statements, bodyScope, 0);
    } finally {
      this.#functionDepth -= 1;
    }
  }

  #validateBlock(
    block: Block,
    parent: SemanticScope,
    loopDepth: number,
  ): void {
    this.#validateStatements(
      block.statements,
      new SemanticScope(parent),
      loopDepth,
    );
  }

  #validateAssignmentTarget(
    target: AssignmentTarget,
    scope: SemanticScope,
  ): void {
    if (target.kind === "identifier") {
      const binding = scope.resolve(target.name);
      if (binding === undefined) {
        this.#report(
          semanticCode.unknownAssignment,
          `Cannot assign to unknown variable '${target.name}'.`,
          target.span,
        );
      } else if (binding.kind === "function") {
        this.#report(
          semanticCode.functionAssignment,
          `Cannot assign to function '${target.name}'.`,
          target.span,
        );
      } else if (binding.kind !== "variable") {
        this.#report(
          semanticCode.invalidAssignment,
          `Cannot replace ${binding.kind} '${target.name}'.`,
          target.span,
        );
      }
      return;
    }

    this.#validateExpression(target.object, scope, null);
    if (target.kind === "indexExpression") {
      this.#validateExpression(target.index, scope, null);
    }
  }

  #validateExpression(
    expression: Expression,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): void {
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "stringLiteral":
        return;
      case "identifier":
        if (expression.name === "speaker" && contextualSpeaker !== null) return;
        const binding = scope.resolve(expression.name);
        if (
          binding === undefined &&
          !this.#builtins.has(expression.name)
        ) {
          this.#report(
            semanticCode.unknownVariable,
            `Unknown variable '${expression.name}'.`,
            expression.span,
          );
        } else if (binding?.kind === "function") {
          this.#report(
            semanticCode.functionValue,
            `Function '${expression.name}' is not a first-class runtime value.`,
            expression.span,
          );
        }
        return;
      case "parenthesizedExpression":
        this.#validateExpression(expression.expression, scope, contextualSpeaker);
        return;
      case "listLiteral":
        for (const element of expression.elements) {
          this.#validateExpression(element, scope, contextualSpeaker);
        }
        return;
      case "setLiteral":
        for (const element of expression.elements) {
          this.#validateExpression(element, scope, contextualSpeaker);
          if (isDefinitelyComposite(element, scope)) {
            this.#report(
              semanticCode.invalidSetElement,
              "Sets may contain only string, boolean, integer, number, or null values.",
              element.span,
            );
          }
        }
        return;
      case "objectLiteral": {
        const names = new Set<string>();
        for (const property of expression.properties) {
          if (names.has(property.name.name)) {
            this.#report(
              semanticCode.duplicateProperty,
              `Duplicate object property '${property.name.name}'.`,
              property.name.span,
            );
          }
          names.add(property.name.name);
          this.#validateExpression(property.value, scope, contextualSpeaker);
        }
        return;
      }
      case "templateLiteral":
        for (const part of expression.parts) {
          if (part.kind === "templateInterpolation") {
            this.#validateExpression(part.expression, scope, contextualSpeaker);
          }
        }
        return;
      case "propertyAccessExpression":
        this.#validateExpression(expression.object, scope, contextualSpeaker);
        return;
      case "indexExpression":
        this.#validateExpression(expression.object, scope, contextualSpeaker);
        this.#validateExpression(expression.index, scope, contextualSpeaker);
        return;
      case "callExpression":
        if (expression.callee.kind === "identifier") {
          const name = expression.callee.name;
          const binding = scope.resolve(name);
          const declaration = this.#functions.get(name);
          if (declaration !== undefined && binding?.kind === "function") {
            this.#validateFunctionCall(expression, declaration);
          } else if (this.#builtins.has(name)) {
            // Injected and core built-ins validate their values at runtime.
          } else if (binding !== undefined) {
            this.#report(
              semanticCode.nonCallable,
              `'${name}' is a ${binding.kind}, not a callable function.`,
              expression.callee.span,
            );
          } else {
            this.#report(
              semanticCode.unknownFunction,
              `Unknown function '${name}'.`,
              expression.callee.span,
            );
          }
        } else {
          this.#validateExpression(expression.callee, scope, contextualSpeaker);
        }
        for (const argument of expression.arguments) {
          this.#validateExpression(argument.value, scope, contextualSpeaker);
        }
        if (
          expression.callee.kind === "identifier" &&
          expression.callee.name === "randomInteger" &&
          expression.arguments.length === 1
        ) {
          const argument = expression.arguments[0]!.value;
          if (
            argument.kind === "rangeExpression" &&
            (!isKnownInteger(argument.start) || !isKnownInteger(argument.end))
          ) {
            this.#report(
              semanticCode.invalidRangeOperand,
              "A statically known randomInteger range must have integer bounds.",
              argument.span,
            );
          }
        }
        return;
      case "unaryExpression":
        this.#validateExpression(expression.operand, scope, contextualSpeaker);
        return;
      case "binaryExpression":
        this.#validateExpression(expression.left, scope, contextualSpeaker);
        this.#validateExpression(expression.right, scope, contextualSpeaker);
        return;
      case "rangeExpression":
        this.#validateExpression(expression.start, scope, contextualSpeaker);
        this.#validateExpression(expression.end, scope, contextualSpeaker);
        if (
          expression.start.kind === "rangeExpression" ||
          expression.end.kind === "rangeExpression"
        ) {
          this.#report(
            semanticCode.chainedRange,
            "Ranges may not be chained.",
            expression.span,
          );
        }
        if (
          isDefinitelyNonNumeric(expression.start) ||
          isDefinitelyNonNumeric(expression.end)
        ) {
          this.#report(
            semanticCode.invalidRangeOperand,
            "Range bounds must be numeric values.",
            expression.span,
          );
        }
        return;
    }
  }

  #validateFunctionCall(
    expression: Extract<Expression, { kind: "callExpression" }>,
    declaration: FunctionDeclaration,
  ): void {
    const positional = expression.arguments.filter(
      (argument) => argument.kind === "positionalArgument",
    );
    const named = expression.arguments.filter(
      (argument) => argument.kind === "namedArgument",
    );
    if (positional.length > 0 && named.length > 0) {
      this.#report(
        semanticCode.mixedArguments,
        "Positional and named arguments may not be mixed in one call.",
        expression.span,
      );
      return;
    }
    const required = declaration.parameters.filter(
      (parameter) => parameter.defaultValue === null,
    ).length;
    if (named.length === 0) {
      if (
        positional.length < required ||
        positional.length > declaration.parameters.length
      ) {
        this.#report(
          semanticCode.argumentCount,
          `Function '${declaration.name.name}' expects ${required} through ${declaration.parameters.length} positional argument(s), received ${positional.length}.`,
          expression.span,
        );
      }
      return;
    }
    const parameters = new Map(
      declaration.parameters.map((parameter) => [parameter.name.name, parameter]),
    );
    const supplied = new Set<string>();
    for (const argument of named) {
      if (!parameters.has(argument.name.name)) {
        this.#report(
          semanticCode.unknownNamedArgument,
          `Unknown argument '${argument.name.name}' for function '${declaration.name.name}'.`,
          argument.name.span,
        );
      } else if (supplied.has(argument.name.name)) {
        this.#report(
          semanticCode.duplicateNamedArgument,
          `Duplicate named argument '${argument.name.name}'.`,
          argument.name.span,
        );
      }
      supplied.add(argument.name.name);
    }
    for (const parameter of declaration.parameters) {
      if (parameter.defaultValue === null && !supplied.has(parameter.name.name)) {
        this.#report(
          semanticCode.missingNamedArgument,
          `Missing required named argument '${parameter.name.name}'.`,
          expression.span,
        );
      }
    }
  }

  #reportLaterParameterReferences(
    expression: Expression,
    laterNames: ReadonlySet<string>,
  ): void {
    visitExpression(expression, (identifier) => {
      if (!laterNames.has(identifier.name)) return;
      this.#report(
        semanticCode.laterParameterDefault,
        `Default expression may not reference later parameter '${identifier.name}'.`,
        identifier.span,
      );
    });
  }

  #declare(
    name: string,
    kind: BindingKind,
    span: SourceSpan,
    scope: SemanticScope,
  ): boolean {
    if (this.#builtins.has(name)) {
      this.#report(
        semanticCode.duplicateDeclaration,
        `Declaration '${name}' conflicts with a protected built-in.`,
        span,
      );
      return false;
    }
    if (scope.declare(name, { kind })) return true;
    this.#report(
      semanticCode.duplicateDeclaration,
      `Declaration '${name}' duplicates a visible name.`,
      span,
    );
    return false;
  }

  #validateSpeakerReference(
    name: string,
    span: SourceSpan,
    scope: SemanticScope,
  ): boolean {
    if (scope.resolve(name)?.kind === "speaker") return true;
    this.#report(
      semanticCode.unknownSpeaker,
      `Unknown speaker '${name}'.`,
      span,
    );
    return false;
  }

  #report(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push(
      createDiagnostic(DiagnosticSeverity.Error, code, message, span),
    );
  }
}

function isKnownInteger(expression: Expression): boolean {
  const value = knownNumber(expression);
  return value === undefined || Number.isInteger(value);
}

function knownNumber(expression: Expression): number | undefined {
  if (expression.kind === "numberLiteral") return expression.value;
  if (expression.kind === "parenthesizedExpression") {
    return knownNumber(expression.expression);
  }
  if (
    expression.kind === "unaryExpression" &&
    (expression.operator === "+" || expression.operator === "-")
  ) {
    const operand = knownNumber(expression.operand);
    if (operand === undefined) return undefined;
    return expression.operator === "+" ? operand : -operand;
  }
  return undefined;
}

function isDefinitelyNonNumeric(expression: Expression): boolean {
  if (expression.kind === "parenthesizedExpression") {
    return isDefinitelyNonNumeric(expression.expression);
  }
  return (
    expression.kind === "stringLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "listLiteral" ||
    expression.kind === "setLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "templateLiteral" ||
    expression.kind === "rangeExpression"
  );
}

function isDefinitelyNonIterable(expression: Expression): boolean {
  if (expression.kind === "parenthesizedExpression") {
    return isDefinitelyNonIterable(expression.expression);
  }
  return (
    expression.kind === "stringLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "numberLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "templateLiteral"
  );
}

function isDefinitelyComposite(
  expression: Expression,
  scope: SemanticScope,
): boolean {
  if (
    expression.kind === "listLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "setLiteral"
  ) {
    return true;
  }
  if (expression.kind === "parenthesizedExpression") {
    return isDefinitelyComposite(expression.expression, scope);
  }
  return (
    expression.kind === "identifier" &&
    scope.resolve(expression.name)?.kind === "speaker"
  );
}

function visitExpression(
  expression: Expression,
  visitor: (identifier: Extract<Expression, { kind: "identifier" }>) => void,
): void {
  switch (expression.kind) {
    case "identifier":
      visitor(expression);
      return;
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "stringLiteral":
      return;
    case "parenthesizedExpression":
      visitExpression(expression.expression, visitor);
      return;
    case "listLiteral":
    case "setLiteral":
      expression.elements.forEach((element) => visitExpression(element, visitor));
      return;
    case "objectLiteral":
      expression.properties.forEach((property) => visitExpression(property.value, visitor));
      return;
    case "templateLiteral":
      expression.parts.forEach((part) => {
        if (part.kind === "templateInterpolation") {
          visitExpression(part.expression, visitor);
        }
      });
      return;
    case "propertyAccessExpression":
      visitExpression(expression.object, visitor);
      return;
    case "indexExpression":
      visitExpression(expression.object, visitor);
      visitExpression(expression.index, visitor);
      return;
    case "callExpression":
      visitExpression(expression.callee, visitor);
      expression.arguments.forEach((argument) => visitExpression(argument.value, visitor));
      return;
    case "unaryExpression":
      visitExpression(expression.operand, visitor);
      return;
    case "binaryExpression":
      visitExpression(expression.left, visitor);
      visitExpression(expression.right, visitor);
      return;
    case "rangeExpression":
      visitExpression(expression.start, visitor);
      visitExpression(expression.end, visitor);
      return;
  }
}
