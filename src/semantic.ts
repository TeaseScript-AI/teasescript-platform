import type {
  AssignmentTarget,
  Block,
  Expression,
  FunctionDeclaration,
  Program,
  Statement,
} from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import type { SourceSpan } from "./source.js";
import {
  CORE_RUNTIME_BUILTINS,
  PLATFORM_STANDARD_LIBRARY_PRELUDE,
  TEASESCRIPT_PROTECTED_NAMES,
} from "./protected-names.js";
import { staticNumber, staticVisibleText } from "./static-evaluation.js";
import { runCompileTask, compileChild, type CompileTask } from "./compiler/continuation.js";
import { expressionChildren } from "./expression-children.js";

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
  invalidInteractionChoice: "TSV029",
  duplicateInteractionChoice: "TSV030",
  unsupportedBlockingContext: "TSV032",
} as const;

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

  readonly #protectedNames: ReadonlySet<string>;

  readonly #root = new SemanticScope();

  readonly #functions = new Map<string, FunctionDeclaration>();

  readonly #invalidConfiguredNames: readonly string[];

  #functionDepth = 0;

  public constructor(options: SemanticValidationOptions) {
    this.#invalidConfiguredNames = Object.freeze(
      [...(options.globals ?? []), ...(options.builtins ?? [])].filter((name) =>
        ["showButton", "askText", "askNumber", "choose"].includes(name),
      ),
    );
    this.#builtins = new Set([
      ...CORE_RUNTIME_BUILTINS,
      ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
      ...(options.builtins ?? []),
    ]);
    this.#protectedNames = new Set([...TEASESCRIPT_PROTECTED_NAMES, ...(options.builtins ?? [])]);
    for (const name of options.globals ?? []) {
      this.#root.declare(name, { kind: "global" });
    }
  }

  public validate(program: Program): void {
    for (const name of new Set(this.#invalidConfiguredNames)) {
      this.#report(
        semanticCode.duplicateDeclaration,
        `Configured name '${name}' conflicts with a protected TeaseScript name.`,
        program.span,
      );
    }
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

  #validateStatement(statement: Statement, scope: SemanticScope, loopDepth: number): void {
    switch (statement.kind) {
      case "letStatement":
        this.#validateExpression(statement.initializer, scope, null);
        this.#declare(statement.name.name, "variable", statement.name.span, scope);
        return;
      case "speakerDeclaration": {
        const declared = this.#declare(statement.name.name, "speaker", statement.name.span, scope);
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
          this.#validateExpression(property.value, scope, declared ? statement.name.name : null);
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
            : this.#validateSpeakerReference(statement.speaker.name, statement.speaker.span, scope)
              ? statement.speaker.name
              : null;
        this.#validateExpression(statement.value, scope, contextualSpeaker);
        if (statement.pacing !== null && statement.pacing !== "instant") {
          this.#validateExpression(statement.pacing, scope, contextualSpeaker);
          const known = staticNumber(statement.pacing);
          if (known !== undefined && known < 0) {
            this.#report(
              semanticCode.invalidRepeatCount,
              "Say pacing must not be negative.",
              statement.pacing.span,
            );
          }
        }
        return;
      }
      case "showButtonStatement": {
        const contextualSpeaker = this.#interactionSpeaker(statement.speaker, scope);
        this.#validateExpression(statement.label, scope, contextualSpeaker);
        return;
      }
      case "waitStatement": {
        this.#validateExpression(statement.duration, scope, null);
        const known = staticNumber(statement.duration);
        if (known !== undefined && known < 0) {
          this.#report(
            semanticCode.invalidRepeatCount,
            "Wait duration must not be negative.",
            statement.duration.span,
          );
        }
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
        const knownCount = staticNumber(statement.count);
        if (knownCount !== undefined && (!Number.isInteger(knownCount) || knownCount < 0)) {
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
          (!isKnownInteger(statement.iterable.start) || !isKnownInteger(statement.iterable.end))
        ) {
          this.#report(
            semanticCode.invalidRangeOperand,
            "A statically known iterated range must have integer bounds.",
            statement.iterable.span,
          );
        }
        const loopScope = new SemanticScope(scope);
        this.#declare(statement.variable.name, "variable", statement.variable.span, loopScope);
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
    const laterNameCounts = new Map<string, number>();
    for (const parameter of declaration.parameters) {
      const name = parameter.name.name;
      laterNameCounts.set(name, (laterNameCounts.get(name) ?? 0) + 1);
    }
    for (const parameter of declaration.parameters) {
      const name = parameter.name.name;
      const remaining = (laterNameCounts.get(name) ?? 1) - 1;
      if (remaining === 0) {
        laterNameCounts.delete(name);
      } else {
        laterNameCounts.set(name, remaining);
      }
      if (parameter.defaultValue !== null) {
        const blockingInteraction = findFirstInteraction(parameter.defaultValue);
        if (blockingInteraction !== null) {
          this.#report(
            semanticCode.unsupportedBlockingContext,
            "Blocking interactions are not supported in function parameter defaults.",
            blockingInteraction.span,
          );
        }
        this.#reportLaterParameterReferences(parameter.defaultValue, laterNameCounts);
        this.#validateExpression(parameter.defaultValue, defaultScope, null);
      }
      defaultScope.declare(name, { kind: "variable" });
    }

    this.#functionDepth += 1;
    try {
      this.#validateStatements(declaration.body.statements, bodyScope, 0);
    } finally {
      this.#functionDepth -= 1;
    }
  }

  #validateBlock(block: Block, parent: SemanticScope, loopDepth: number): void {
    this.#validateStatements(block.statements, new SemanticScope(parent), loopDepth);
  }

  #validateAssignmentTarget(target: AssignmentTarget, scope: SemanticScope): void {
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
    return runCompileTask(this.#validateExpressionTask(expression, scope, contextualSpeaker));
  }

  *#validateExpressionTask(
    expression: Expression,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    while (expression.kind === "parenthesizedExpression" || expression.kind === "unaryExpression") {
      expression =
        expression.kind === "parenthesizedExpression" ? expression.expression : expression.operand;
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
        return;
      case "stringLiteral":
        for (const part of expression.parts) {
          if (part.kind === "stringInterpolation") {
            yield* compileChild(
              this.#validateExpressionTask(part.expression, scope, contextualSpeaker),
            );
          }
        }
        return;
      case "interactionExpression": {
        const contextualSpeaker = this.#interactionSpeaker(expression.speaker, scope);
        if (expression.interactionKind === "choice") {
          yield* compileChild(this.#validateChoiceTask(expression, scope, contextualSpeaker));
        } else if (expression.hint !== null) {
          yield* compileChild(
            this.#validateExpressionTask(expression.hint, scope, contextualSpeaker),
          );
        }
        return;
      }
      case "identifier":
        if (expression.name === "speaker" && contextualSpeaker !== null) return;
        const binding = scope.resolve(expression.name);
        if (binding === undefined) {
          if (this.#builtins.has(expression.name)) {
            this.#report(
              semanticCode.functionValue,
              `Builtin '${expression.name}' is not a first-class runtime value.`,
              expression.span,
            );
          } else {
            this.#report(
              semanticCode.unknownVariable,
              `Unknown variable '${expression.name}'.`,
              expression.span,
            );
          }
        } else if (binding.kind === "function") {
          this.#report(
            semanticCode.functionValue,
            `Function '${expression.name}' is not a first-class runtime value.`,
            expression.span,
          );
        }
        return;
      case "listLiteral":
      case "setLiteral":
        yield* compileChild(
          this.#validateCollectionExpressionTask(expression, scope, contextualSpeaker),
        );
        return;
      case "objectLiteral":
        yield* compileChild(
          this.#validateCollectionExpressionTask(expression, scope, contextualSpeaker),
        );
        return;
      case "propertyAccessExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.object, scope, contextualSpeaker),
        );
        return;
      case "indexExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.object, scope, contextualSpeaker),
        );
        yield* compileChild(
          this.#validateExpressionTask(expression.index, scope, contextualSpeaker),
        );
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
          yield* compileChild(
            this.#validateExpressionTask(expression.callee, scope, contextualSpeaker),
          );
        }
        for (const argument of expression.arguments) {
          yield* compileChild(
            this.#validateExpressionTask(argument.value, scope, contextualSpeaker),
          );
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
      case "binaryExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.left, scope, contextualSpeaker),
        );
        yield* compileChild(
          this.#validateExpressionTask(expression.right, scope, contextualSpeaker),
        );
        return;
      case "rangeExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.start, scope, contextualSpeaker),
        );
        yield* compileChild(this.#validateExpressionTask(expression.end, scope, contextualSpeaker));
        if (
          expression.start.kind === "rangeExpression" ||
          expression.end.kind === "rangeExpression"
        ) {
          this.#report(semanticCode.chainedRange, "Ranges may not be chained.", expression.span);
        }
        if (isDefinitelyNonNumeric(expression.start) || isDefinitelyNonNumeric(expression.end)) {
          this.#report(
            semanticCode.invalidRangeOperand,
            "Range bounds must be numeric values.",
            expression.span,
          );
        }
        return;
    }
    expression satisfies never;
  }

  #interactionSpeaker(
    speaker: Extract<Expression, { kind: "interactionExpression" }>["speaker"],
    scope: SemanticScope,
  ): string | null {
    return speaker === null
      ? "speaker"
      : this.#validateSpeakerReference(speaker.name, speaker.span, scope)
        ? speaker.name
        : null;
  }

  *#validateChoiceTask(
    expression: Extract<Expression, { kind: "interactionExpression" }>,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    if (expression.options.length === 0) {
      this.#report(
        semanticCode.invalidInteractionChoice,
        "A choice requires at least one option.",
        expression.span,
      );
      return;
    }
    const labelled = expression.options.map((option) => option.label !== null);
    if (labelled.some(Boolean) && labelled.some((value) => !value)) {
      this.#report(
        semanticCode.invalidInteractionChoice,
        "Labelled and unlabelled choice options may not be mixed.",
        expression.span,
      );
    }
    const labelKinds = new Set(
      expression.options.flatMap((option) => (option.label === null ? [] : [option.label.kind])),
    );
    if (labelKinds.size > 1) {
      this.#report(
        semanticCode.invalidInteractionChoice,
        "Identifier and numeric choice labels may not be mixed.",
        expression.span,
      );
    }
    const labels = new Set<string>();
    const visible = new Map<string, SourceSpan>();
    for (const option of expression.options) {
      yield* compileChild(this.#validateExpressionTask(option.value, scope, contextualSpeaker));
      if (option.label !== null) {
        const key =
          option.label.kind === "identifier"
            ? `identifier:${option.label.name}`
            : `number:${Object.is(option.label.value, -0) ? 0 : option.label.value}`;
        if (labels.has(key)) {
          this.#report(
            semanticCode.duplicateInteractionChoice,
            "Choice labels must be unique.",
            option.label.span,
          );
        }
        labels.add(key);
      } else {
        const text = staticVisibleText(option.value);
        if (text !== undefined) {
          if (visible.has(text)) {
            this.#report(
              semanticCode.duplicateInteractionChoice,
              "Unlabelled choice text must be unique.",
              option.value.span,
            );
          }
          visible.set(text, option.value.span);
        }
      }
    }
  }

  *#validateCollectionExpressionTask(
    root: Extract<Expression, { kind: "listLiteral" | "setLiteral" | "objectLiteral" }>,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    if (root.kind === "objectLiteral") {
      const names = new Set<string>();
      for (const property of root.properties) {
        if (names.has(property.name.name))
          this.#report(
            semanticCode.duplicateProperty,
            `Duplicate object property '${property.name.name}'.`,
            property.name.span,
          );
        names.add(property.name.name);
        yield* compileChild(this.#validateExpressionTask(property.value, scope, contextualSpeaker));
      }
      return;
    }
    for (const element of root.elements) {
      yield* compileChild(this.#validateExpressionTask(element, scope, contextualSpeaker));
      if (root.kind === "setLiteral" && isDefinitelyComposite(element, scope))
        this.#report(
          semanticCode.invalidSetElement,
          "Sets may contain only string, boolean, integer, number, or null values.",
          element.span,
        );
    }
  }

  #validateFunctionCall(
    expression: Extract<Expression, { kind: "callExpression" }>,
    declaration: FunctionDeclaration,
  ): void {
    const positional = expression.arguments.filter(
      (argument) => argument.kind === "positionalArgument",
    );
    const named = expression.arguments.filter((argument) => argument.kind === "namedArgument");
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
      if (positional.length < required || positional.length > declaration.parameters.length) {
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
    laterNameCounts: ReadonlyMap<string, number>,
  ): void {
    visitExpression(expression, (identifier) => {
      if (!laterNameCounts.has(identifier.name)) return;
      this.#report(
        semanticCode.laterParameterDefault,
        `Default expression may not reference later parameter '${identifier.name}'.`,
        identifier.span,
      );
    });
  }

  #declare(name: string, kind: BindingKind, span: SourceSpan, scope: SemanticScope): boolean {
    if (this.#protectedNames.has(name)) {
      this.#report(
        semanticCode.duplicateDeclaration,
        `Declaration '${name}' conflicts with a protected TeaseScript name.`,
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

  #validateSpeakerReference(name: string, span: SourceSpan, scope: SemanticScope): boolean {
    if (scope.resolve(name)?.kind === "speaker") return true;
    this.#report(semanticCode.unknownSpeaker, `Unknown speaker '${name}'.`, span);
    return false;
  }

  #report(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push(createDiagnostic(DiagnosticSeverity.Error, code, message, span));
  }
}

function isKnownInteger(expression: Expression): boolean {
  const value = staticNumber(expression);
  return value === undefined || Number.isInteger(value);
}

function findFirstInteraction(
  expression: Expression,
): Extract<Expression, { kind: "interactionExpression" }> | null {
  const work = [expression];
  while (work.length) {
    const current = work.pop()!;
    if (current.kind === "interactionExpression") return current;
    const children = expressionChildren(current);
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
  }
  return null;
}

function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

function isDefinitelyNonNumeric(expression: Expression): boolean {
  expression = unwrapParentheses(expression);
  if (expression.kind === "interactionExpression") {
    if (expression.interactionKind === "number") return false;
    if (expression.interactionKind !== "choice") return true;
    return expression.options[0]?.label?.kind !== "numberLiteral";
  }
  return (
    expression.kind === "stringLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "listLiteral" ||
    expression.kind === "setLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "rangeExpression"
  );
}

function isDefinitelyNonIterable(expression: Expression): boolean {
  expression = unwrapParentheses(expression);
  return (
    expression.kind === "stringLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "numberLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "interactionExpression"
  );
}

function isDefinitelyComposite(expression: Expression, scope: SemanticScope): boolean {
  expression = unwrapParentheses(expression);
  if (
    expression.kind === "listLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "setLiteral"
  ) {
    return true;
  }
  return expression.kind === "identifier" && scope.resolve(expression.name)?.kind === "speaker";
}

function visitExpression(
  expression: Expression,
  visitor: (identifier: Extract<Expression, { kind: "identifier" }>) => void,
): void {
  const work = [expression];
  while (work.length) {
    const current = work.pop()!;
    if (current.kind === "identifier") visitor(current);
    const children =
      current.kind === "interactionExpression"
        ? [
            ...(current.speaker === null ? [] : [current.speaker]),
            ...(current.hint === null ? [] : [current.hint]),
            ...current.options.map((option) => option.value),
          ]
        : expressionChildren(current);
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
  }
}
