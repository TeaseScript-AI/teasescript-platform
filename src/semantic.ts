import type {
  AssignmentTarget,
  Block,
  Expression,
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

type BindingKind = "variable" | "speaker" | "global";

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
  readonly #root = new SemanticScope();

  public constructor(options: SemanticValidationOptions) {
    this.#builtins = new Set(options.builtins ?? []);
    for (const name of options.globals ?? []) {
      this.#root.declare(name, { kind: "global" });
    }
  }

  public validate(program: Program): void {
    this.#validateStatements(program.statements, this.#root);
  }

  #validateStatements(
    statements: readonly Statement[],
    scope: SemanticScope,
  ): void {
    for (const statement of statements) this.#validateStatement(statement, scope);
  }

  #validateStatement(statement: Statement, scope: SemanticScope): void {
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
        this.#validateBlock(statement.thenBlock, scope);
        if (statement.elseBlock !== null) {
          this.#validateBlock(statement.elseBlock, scope);
        }
        return;
      case "exitStatement":
        return;
    }
  }

  #validateBlock(block: Block, parent: SemanticScope): void {
    this.#validateStatements(block.statements, new SemanticScope(parent));
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
        if (
          scope.resolve(expression.name) === undefined &&
          !this.#builtins.has(expression.name)
        ) {
          this.#report(
            semanticCode.unknownVariable,
            `Unknown variable '${expression.name}'.`,
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
        this.#validateExpression(expression.callee, scope, contextualSpeaker);
        for (const argument of expression.arguments) {
          this.#validateExpression(argument.value, scope, contextualSpeaker);
        }
        return;
      case "unaryExpression":
        this.#validateExpression(expression.operand, scope, contextualSpeaker);
        return;
      case "binaryExpression":
        this.#validateExpression(expression.left, scope, contextualSpeaker);
        this.#validateExpression(expression.right, scope, contextualSpeaker);
        return;
    }
  }

  #declare(
    name: string,
    kind: BindingKind,
    span: SourceSpan,
    scope: SemanticScope,
  ): boolean {
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
