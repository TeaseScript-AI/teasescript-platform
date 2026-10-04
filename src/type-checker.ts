import type {
  AssignmentStatement,
  Block,
  CallExpression,
  Expression,
  FunctionDeclaration,
  LetStatement,
  MediaParts,
  Program,
  Statement,
  TimerParts,
} from "./ast.js";
import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { mediaHandlerBlocks, mediaOperands } from "./expression-children.js";
import {
  isBlankTextAnswer,
  isValidInteractionPrefill,
  numberAnswerText,
} from "./interaction-answers.js";
import { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "./protected-names.js";
import type { SourceSpan } from "./source.js";
import { staticVisibleText } from "./static-evaluation.js";
import {
  arithmeticType,
  BOOLEAN_TYPE,
  containsType,
  copyType,
  decidedType,
  describeValue,
  DURATION_TYPE,
  elementType,
  INTEGER_TYPE,
  isAnnotatable,
  isAssignable,
  isKnown,
  isNullable,
  isNumeric,
  isScalar,
  joinTypes,
  members,
  misfitProperty,
  NEVER_TYPE,
  nonNullType,
  NULL_TYPE,
  NUMBER_TYPE,
  openType,
  optional,
  placeType,
  resolved,
  settle,
  STRING_TYPE,
  typeFromAnnotation,
  typeName,
  UNKNOWN_TYPE,
  type StaticType,
} from "./static-types.js";

export interface TypeCheckOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
}

export interface TypeCheckResult {
  readonly diagnostics: readonly Diagnostic[];
}

const typeCode = {
  invalidInteractionDefault: "TSV039",
  typeMismatch: "TSV041",
  invalidOperand: "TSV043",
  mixedTypes: "TSV044",
} as const;

/**
 * Checks that every variable, list or set element, object property, function parameter, and function result keeps one
 * type, and that operations receive values they support (ADR 0021). It runs after name validation succeeded, so every
 * name resolves; a value it cannot know has the type `unknown` and is never rejected.
 */
export function checkTypes(program: Program, options: TypeCheckOptions = {}): TypeCheckResult {
  const checker = new TypeChecker(options);
  checker.check(program);
  return Object.freeze({ diagnostics: Object.freeze([...checker.diagnostics]) });
}

/** A variable and the type it keeps. Open slots and object property tables inside `type` record later decisions. */
interface Variable {
  readonly name: string;
  readonly type: StaticType;
}

type Entry =
  | { readonly kind: "variable"; readonly variable: Variable }
  | { readonly kind: "speaker" | "global" }
  | { readonly kind: "function"; readonly fn: FunctionType };

class Scope {
  readonly #entries = new Map<string, Entry>();

  public constructor(readonly parent: Scope | null) {}

  public resolve(name: string): Entry | undefined {
    for (let scope: Scope | null = this; scope !== null; scope = scope.parent) {
      const entry = scope.#entries.get(name);
      if (entry !== undefined) return entry;
    }
    return undefined;
  }

  public declare(name: string, entry: Entry): void {
    this.#entries.set(name, entry);
  }
}

/** A function's parameter types and result type, both computed once, when first needed. */
interface FunctionType {
  readonly declaration: FunctionDeclaration;
  parameters: readonly Variable[] | null;
  result: StaticType | null;
  checking: boolean;
}

/** The function whose body is being checked, with what its `return` statements produced. */
interface FunctionContext {
  readonly fn: FunctionType;
  readonly declared: StaticType | null;
  readonly returns: { readonly type: StaticType; readonly span: SourceSpan }[];
  returnsNull: boolean;
}

/** A place that keeps a type, and the words that describe it in a mismatch message. */
interface Place {
  readonly type: StaticType;
  /** The source spelling of the place, such as `items` or `door.locked`, when it has one. */
  readonly label: string | null;
  /** For the elements of a collection, the collection's spelling, so element properties can be named. */
  readonly elementOf?: string | null;
  /** For example `'score' holds a whole number (integer)` or `'scores' holds integer values (integer[])`. */
  readonly subject: string;
  /** What the value would do: `start as`, `be set to`, `contain`, `take`, or `return`. */
  readonly verb: string;
  /** The suggestion appended to the message, given the rejected value. */
  readonly fix: (value: StaticType, expression: Expression | null) => string;
}

class TypeChecker {
  readonly diagnostics: Diagnostic[] = [];

  readonly #builtins: ReadonlySet<string>;

  readonly #root = new Scope(null);

  readonly #functions: FunctionType[] = [];

  readonly #handlers: { readonly block: Block; readonly selfHandle: string | null }[] = [];

  #function: FunctionContext | null = null;

  readonly #types = new Map<Expression, StaticType>();

  /** One flag per enclosing loop: whether a `break` leaves it. */
  readonly #loops: boolean[] = [];

  public constructor(options: TypeCheckOptions) {
    this.#builtins = new Set([
      ...CORE_RUNTIME_BUILTINS,
      ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
      ...(options.builtins ?? []),
    ]);
    for (const name of options.globals ?? []) this.#root.declare(name, { kind: "global" });
  }

  public check(program: Program): void {
    for (const statement of program.statements) {
      if (statement.kind !== "functionDeclaration") continue;
      const fn: FunctionType = {
        declaration: statement,
        parameters: null,
        result: null,
        checking: false,
      };
      this.#functions.push(fn);
      this.#root.declare(statement.name.name, { kind: "function", fn });
    }
    runCompileTask(
      this.#statementsTask(
        program.statements.filter((statement) => statement.kind !== "functionDeclaration"),
        this.#root,
      ),
    );
    for (const fn of this.#functions) this.#functionResult(fn);
    for (let index = 0; index < this.#handlers.length; index += 1) {
      const handler = this.#handlers[index]!;
      const scope = new Scope(this.#root);
      if (handler.selfHandle !== null)
        scope.declare(handler.selfHandle, {
          kind: "variable",
          variable: { name: handler.selfHandle, type: { kind: "media" } },
        });
      const outer = this.#function;
      this.#function = null;
      runCompileTask(this.#statementsTask(handler.block.statements, scope));
      this.#function = outer;
    }
  }

  // Statements -------------------------------------------------------------------------------------------------------

  /** Checks statements in order and returns whether execution can continue after them. */
  *#statementsTask(statements: readonly Statement[], scope: Scope): CompileTask<boolean> {
    let continues = true;
    for (const statement of statements) {
      if (!(yield* compileChild(this.#statementTask(statement, scope)))) continues = false;
    }
    return continues;
  }

  *#blockTask(block: Block, scope: Scope): CompileTask<boolean> {
    return yield* compileChild(this.#statementsTask(block.statements, new Scope(scope)));
  }

  /** Checks one statement and returns whether execution can continue after it. */
  *#statementTask(statement: Statement, scope: Scope): CompileTask<boolean> {
    switch (statement.kind) {
      case "letStatement":
        yield* compileChild(this.#letTask(statement, scope));
        return true;
      case "assignmentStatement":
        yield* compileChild(this.#assignmentTask(statement, scope));
        return true;
      case "expressionStatement":
        yield* compileChild(this.#expressionTask(statement.expression, scope));
        return true;
      case "speakerDeclaration":
        scope.declare(statement.name.name, { kind: "speaker" });
        for (const property of statement.properties)
          yield* compileChild(this.#expressionTask(property.value, scope));
        return true;
      case "speakerSetterStatement":
      case "hideImageStatement":
        return true;
      case "sayStatement":
        if (statement.presentation !== null)
          yield* compileChild(this.#expressionTask(statement.presentation, scope));
        yield* compileChild(this.#expressionTask(statement.value, scope));
        if (statement.pacing !== null && statement.pacing !== "instant")
          yield* compileChild(
            this.#requireTask(
              statement.pacing,
              scope,
              isNumeric,
              "Say pacing is a number of seconds",
            ),
          );
        return true;
      case "showButtonStatement":
        yield* compileChild(this.#expressionTask(statement.label, scope));
        if (statement.background !== null)
          yield* compileChild(
            this.#requireTask(
              statement.background,
              scope,
              (type) => isScalar(type, "string"),
              "A button background is a colour name or code in text (string)",
            ),
          );
        return true;
      case "waitStatement":
        yield* compileChild(this.#timeTask(statement.duration, statement.unit !== null, scope));
        return true;
      case "timerStatement":
        yield* compileChild(this.#timerTask(statement, scope));
        return true;
      case "playMediaStatement":
        yield* compileChild(this.#mediaTask(statement, scope, null));
        return true;
      case "showImageStatement":
        yield* compileChild(this.#fileTask(statement.image, scope, "showImage"));
        return true;
      case "saveStatement": {
        const value = yield* compileChild(this.#expressionTask(statement.value, scope));
        if (containsType(value, (part) => ["speaker", "timer", "media"].includes(part.kind)))
          this.#report(
            typeCode.invalidOperand,
            `Speakers and timer or media handles cannot be saved, but this is ${describeValue(value)}.`,
            statement.value.span,
          );
        yield* compileChild(this.#storageKeyTask(statement.key, scope));
        return true;
      }
      case "deleteStatement":
        yield* compileChild(this.#storageKeyTask(statement.key, scope));
        return true;
      case "ifStatement": {
        yield* compileChild(this.#conditionTask(statement.condition, scope));
        const thenContinues = yield* compileChild(this.#blockTask(statement.thenBlock, scope));
        if (statement.elseBlock === null) return true;
        const elseContinues =
          statement.elseBlock.kind === "ifStatement"
            ? yield* compileChild(this.#statementTask(statement.elseBlock, scope))
            : yield* compileChild(this.#blockTask(statement.elseBlock, scope));
        return thenContinues || elseContinues;
      }
      case "whileStatement": {
        yield* compileChild(this.#conditionTask(statement.condition, scope));
        this.#loops.push(false);
        yield* compileChild(this.#blockTask(statement.body, scope));
        const broken = this.#loops.pop()!;
        const condition = unwrap(statement.condition);
        // `while true` without a `break` never ends normally.
        return broken || !(condition.kind === "booleanLiteral" && condition.value);
      }
      case "repeatStatement": {
        const count = yield* compileChild(this.#expressionTask(statement.count, scope));
        if (isScalar(count, "number"))
          this.#report(
            typeCode.invalidOperand,
            `A repeat count must be a whole number (integer), but this is ${describeValue(count)}.${ROUND_FIX}.`,
            statement.count.span,
          );
        else
          this.#reportUnless(
            count,
            isScalar(count, "integer"),
            statement.count,
            "A repeat count is a whole number (integer)",
          );
        this.#loops.push(false);
        yield* compileChild(this.#blockTask(statement.body, scope));
        this.#loops.pop();
        return true;
      }
      case "forStatement": {
        const iterable = yield* compileChild(this.#expressionTask(statement.iterable, scope));
        const element = elementType(iterable);
        this.#reportUnless(
          iterable,
          element !== undefined,
          statement.iterable,
          "A for-loop goes through a list, a set, or a range",
        );
        const loopScope = new Scope(scope);
        loopScope.declare(statement.variable.name, {
          kind: "variable",
          variable: {
            name: statement.variable.name,
            type: element === undefined ? UNKNOWN_TYPE : copyType(element),
          },
        });
        this.#loops.push(false);
        yield* compileChild(this.#statementsTask(statement.body.statements, loopScope));
        this.#loops.pop();
        return true;
      }
      case "breakStatement":
        if (this.#loops.length > 0) this.#loops[this.#loops.length - 1] = true;
        return false;
      case "continueStatement":
      case "exitStatement":
        return false;
      case "returnStatement":
        yield* compileChild(this.#returnTask(statement, scope));
        return false;
      case "functionDeclaration":
        return true;
    }
  }

  *#letTask(statement: LetStatement, scope: Scope): CompileTask<void> {
    const name = statement.name.name;
    const initializer = unwrap(statement.initializer);
    const value =
      initializer.kind === "playMediaExpression"
        ? yield* compileChild(this.#mediaTask(initializer, scope, name))
        : yield* compileChild(this.#expressionTask(statement.initializer, scope));
    let type: StaticType;
    if (statement.typeAnnotation === null) {
      type = placeType(value);
    } else {
      type = typeFromAnnotation(statement.typeAnnotation);
      const place: Place = {
        type,
        label: name,
        subject: `'${name}' is declared as ${typeName(type)}`,
        verb: "start as",
        fix: (rejected, expression) => typeFix(name, type, rejected, expression),
      };
      // A typed load's default must fit the variable as well; the loaded value itself is checked at runtime.
      if (initializer.kind === "loadExpression" && initializer.defaultValue !== null) {
        yield* compileChild(
          this.#storeTask(place, initializer.defaultValue, this.#typeOf(initializer.defaultValue)),
        );
      } else {
        yield* compileChild(this.#storeTask(place, statement.initializer, value));
      }
    }
    scope.declare(name, { kind: "variable", variable: { name, type } });
  }

  *#assignmentTask(statement: AssignmentStatement, scope: Scope): CompileTask<void> {
    const target = statement.target;
    let place: Place | undefined;
    if (target.kind === "identifier") {
      const entry = scope.resolve(target.name);
      if (entry?.kind === "variable") place = variablePlace(entry.variable);
    } else {
      const object = yield* compileChild(this.#expressionTask(target.object, scope));
      if (target.kind === "indexExpression") {
        const index = yield* compileChild(this.#expressionTask(target.index, scope));
        this.#checkIndex(object, index, target.index);
        const list = resolved(nonNullType(object));
        if (list.kind === "list")
          place = elementPlace(list, expressionLabel(target.object), isNullable(object));
      } else {
        place = this.#propertyPlace(object, target.object, target.property.name);
      }
    }
    const value = yield* compileChild(this.#expressionTask(statement.value, scope));
    if (place === undefined) return;
    if (statement.operator === "=") {
      yield* compileChild(this.#storeTask(place, statement.value, value));
      return;
    }
    const operator = statement.operator === "+=" ? "+" : "-";
    const kept = resolved(place.type);
    if (kept.kind === "unknown" || kept.kind === "open" || resolved(value).kind === "unknown")
      return;
    const result = arithmeticType(operator, nonNullType(kept), nonNullType(value));
    if (result === undefined) {
      const subject = place.subject;
      this.#report(
        typeCode.typeMismatch,
        `${subject}, so ${describeValue(value)} cannot be ${operator === "+" ? "added to" : "subtracted from"} ${place.verb === "contain" ? "an element" : "it"}.${operandFix(nonNullType(kept), statement.value)}`,
        statement.value.span,
      );
      return;
    }
    if (!isAssignable(place.type, result))
      this.#report(
        typeCode.typeMismatch,
        `${place.subject}, so '${statement.operator}' cannot make ${place.verb === "contain" ? "an element" : "it"} ${describeValue(result)}.${place.fix(result, null)}`,
        statement.value.span,
      );
  }

  /**
   * Stores a value in a place that keeps a type: reports a mismatch, or records what the value decides. A list, set, or
   * object literal is checked part by part, so the message points at the element or property that does not fit.
   */
  *#storeTask(place: Place, expression: Expression, value: StaticType): CompileTask<void> {
    const literal = unwrap(expression);
    const kept = resolved(nonNullType(place.type));
    if (
      (kept.kind === "list" && literal.kind === "listLiteral") ||
      (kept.kind === "set" && literal.kind === "setLiteral")
    ) {
      const elements = elementPlace(kept, place.label, isNullable(place.type));
      for (const element of literal.elements)
        yield* compileChild(this.#storeTask(elements, element, this.#typeOf(element)));
      return;
    }
    if (kept.kind === "object" && literal.kind === "objectLiteral" && kept.properties !== null) {
      for (const property of literal.properties) {
        const known = kept.properties.get(property.name.name);
        const type = this.#typeOf(property.value);
        if (known === undefined) kept.properties.set(property.name.name, placeType(type));
        else
          yield* compileChild(
            this.#storeTask(
              nestedPropertyPlace(known, place, property.name.name),
              property.value,
              type,
            ),
          );
      }
      return;
    }
    if (isAssignable(place.type, value)) {
      settle(place.type, value, expression.span);
      return;
    }
    const property = misfitProperty(kept, value);
    if (property !== undefined) {
      this.#report(
        typeCode.typeMismatch,
        `${place.subject}, so its property '${property.name}', which holds ${describeValue(property.kept)}, cannot be set to ${describeValue(property.value)}. Use a separate property for a value of another type.`,
        expression.span,
      );
      return;
    }
    this.#report(
      typeCode.typeMismatch,
      `${place.subject}, so it cannot ${place.verb} ${describeValue(value)}.${place.fix(value, expression)}`,
      expression.span,
    );
  }

  /** The place of `object.name`: a known object property keeps its type, and a new property starts a new entry. */
  #propertyPlace(
    object: StaticType,
    objectExpression: Expression,
    name: string,
  ): Place | undefined {
    const value = resolved(nonNullType(object));
    const label = `${expressionLabel(objectExpression) ?? "this object"}.${name}`;
    if (value.kind === "timer" || value.kind === "media") {
      const type = handlePropertyType(value.kind, name, "assign");
      return type === undefined ? undefined : propertyPlace(type, label, `'${label}'`);
    }
    if (value.kind !== "object" || value.properties === null) return undefined;
    let type = value.properties.get(name);
    if (type === undefined) {
      type = openType();
      value.properties.set(name, type);
    }
    return propertyPlace(type, label, `'${label}'`);
  }

  *#returnTask(
    statement: Extract<Statement, { kind: "returnStatement" }>,
    scope: Scope,
  ): CompileTask<void> {
    const context = this.#function;
    if (statement.value === null) {
      if (context !== null) {
        context.returnsNull = true;
        if (context.declared !== null && !isNullable(context.declared))
          this.#report(
            typeCode.typeMismatch,
            `'${context.fn.declaration.name.name}' returns ${typeName(context.declared)}, so it cannot return without a value.${optionalResultFix(context.declared)}`,
            statement.span,
          );
      }
      return;
    }
    const value = yield* compileChild(this.#expressionTask(statement.value, scope));
    if (context === null) return;
    const name = context.fn.declaration.name.name;
    if (context.declared !== null) {
      const declared = context.declared;
      yield* compileChild(
        this.#storeTask(
          {
            type: declared,
            label: null,
            subject: `'${name}' returns ${typeName(declared)}`,
            verb: "return",
            fix: (rejected) =>
              resolved(rejected).kind === "null"
                ? optionalResultFix(declared)
                : (conversionFix(declared, rejected, null) ?? ""),
          },
          statement.value,
          value,
        ),
      );
      return;
    }
    context.returns.push({ type: value, span: statement.value.span });
  }

  // Functions --------------------------------------------------------------------------------------------------------

  /** The result type of a function, checking its body the first time. A recursive call sees an unknown result. */
  #functionResult(fn: FunctionType): StaticType {
    if (fn.result !== null) return fn.result;
    if (fn.checking) return UNKNOWN_TYPE;
    fn.checking = true;
    const declaration = fn.declaration;
    const parameters = this.#parameters(fn);
    const scope = new Scope(this.#root);
    for (const parameter of parameters)
      scope.declare(parameter.name, { kind: "variable", variable: parameter });
    const declared =
      declaration.returnTypeAnnotation === null
        ? null
        : typeFromAnnotation(declaration.returnTypeAnnotation);
    const context: FunctionContext = { fn, declared, returns: [], returnsNull: false };
    const outer = this.#function;
    const outerLoops = this.#loops.splice(0);
    this.#function = context;
    const continues = runCompileTask(this.#statementsTask(declaration.body.statements, scope));
    this.#function = outer;
    this.#loops.push(...outerLoops);
    if (continues) context.returnsNull = true;
    fn.result = declared ?? this.#inferredResult(context);
    if (
      declared !== null &&
      continues &&
      !isNullable(declared) &&
      resolved(declared).kind !== "unknown"
    )
      this.#report(
        typeCode.typeMismatch,
        `'${declaration.name.name}' returns ${typeName(declared)}, but it can end without returning a value. Add a 'return' at the end.${optionalResultFix(declared)}`,
        declaration.name.span,
      );
    fn.checking = false;
    return fn.result;
  }

  /** One type for every `return` value (ADR 0021 rule 1.5); a function that can end without a value may give null. */
  #inferredResult(context: FunctionContext): StaticType {
    let result: StaticType | undefined;
    let first: { readonly type: StaticType; readonly span: SourceSpan } | undefined;
    for (const returned of context.returns) {
      if (resolved(returned.type).kind === "unknown") continue;
      if (result === undefined) {
        result = returned.type;
        first = returned;
        continue;
      }
      const joined = joinTypes(result, returned.type);
      if (joined === undefined) {
        this.#report(
          typeCode.mixedTypes,
          `'${context.fn.declaration.name.name}' returns ${describeValue(returned.type)} here, but ${describeValue(first!.type)} on line ${first!.span.start.line + 1}. A function returns one type; use a separate function for values of another type.`,
          returned.span,
        );
        continue;
      }
      result = joined;
    }
    if (
      context.returns.some((returned) => resolved(returned.type).kind === "unknown") &&
      result === undefined
    )
      return UNKNOWN_TYPE;
    if (result === undefined) return NULL_TYPE;
    return context.returnsNull ? optional(result) : result;
  }

  /**
   * Parameter types: an annotation, else the type a default gives a `let` variable, else unknown. A default that does
   * not decide a type, such as `null` or `[]`, leaves the parameter unknown, because call sites never decide it.
   */
  #parameters(fn: FunctionType): readonly Variable[] {
    if (fn.parameters !== null) return fn.parameters;
    const parameters: Variable[] = [];
    fn.parameters = parameters;
    const scope = new Scope(this.#root);
    for (const parameter of fn.declaration.parameters) {
      const name = parameter.name.name;
      let type: StaticType = UNKNOWN_TYPE;
      if (parameter.typeAnnotation !== null) type = typeFromAnnotation(parameter.typeAnnotation);
      if (parameter.defaultValue !== null) {
        const value = runCompileTask(this.#expressionTask(parameter.defaultValue, scope));
        if (parameter.typeAnnotation === null) type = decidedType(placeType(value));
        else {
          const declared = type;
          runCompileTask(
            this.#storeTask(
              {
                type: declared,
                label: name,
                subject: `Parameter '${name}' is declared as ${typeName(declared)}`,
                verb: "default to",
                fix: (rejected, expression) => parameterFix(name, declared, rejected, expression),
              },
              parameter.defaultValue,
              value,
            ),
          );
        }
      }
      const variable = { name, type };
      parameters.push(variable);
      scope.declare(name, { kind: "variable", variable });
    }
    return parameters;
  }

  /** Checks the arguments of a call to an author function against its parameter types. */
  *#functionCallTask(
    expression: CallExpression,
    fn: FunctionType,
    scope: Scope,
  ): CompileTask<StaticType> {
    const parameters = this.#parameters(fn);
    const declarations = fn.declaration.parameters;
    let position = 0;
    for (const argument of expression.arguments) {
      const index =
        argument.kind === "positionalArgument"
          ? position++
          : declarations.findIndex((parameter) => parameter.name.name === argument.name.name);
      const value = yield* compileChild(this.#expressionTask(argument.value, scope));
      const parameter = parameters[index];
      if (parameter === undefined) continue;
      const declaration = declarations[index]!;
      const name = fn.declaration.name.name;
      yield* compileChild(
        this.#storeTask(
          {
            type: parameter.type,
            label: parameter.name,
            subject: `'${name}' takes '${parameter.name}' as ${describeValue(parameter.type)}`,
            verb: "take",
            fix: (rejected, value) =>
              declaration.typeAnnotation === null && declaration.defaultValue !== null
                ? parameterFix(
                    parameter.name,
                    parameter.type,
                    rejected,
                    value,
                    declaration.defaultValue,
                  )
                : parameterFix(parameter.name, parameter.type, rejected, value),
          },
          argument.value,
          value,
        ),
      );
    }
    return copyType(this.#functionResult(fn));
  }

  // Expressions ------------------------------------------------------------------------------------------------------

  /**
   * The type of an expression; reports operations on values that do not support them. Each expression is checked once,
   * and its type is kept for the stores that later check its parts.
   */
  *#expressionTask(expression: Expression, scope: Scope): CompileTask<StaticType> {
    const type = yield* compileChild(this.#expressionTypeTask(expression, scope));
    this.#types.set(expression, type);
    return type;
  }

  /** The type of an expression that {@link #expressionTask} already checked. */
  #typeOf(expression: Expression): StaticType {
    return this.#types.get(expression) ?? UNKNOWN_TYPE;
  }

  *#expressionTypeTask(expression: Expression, scope: Scope): CompileTask<StaticType> {
    switch (expression.kind) {
      case "booleanLiteral":
        return BOOLEAN_TYPE;
      case "nullLiteral":
        return NULL_TYPE;
      case "numberLiteral":
        return expression.numericType === "integer" ? INTEGER_TYPE : NUMBER_TYPE;
      case "durationLiteral":
        return DURATION_TYPE;
      case "stringLiteral":
        for (const part of expression.parts)
          if (part.kind === "stringInterpolation")
            yield* compileChild(this.#expressionTask(part.expression, scope));
        return STRING_TYPE;
      case "parenthesizedExpression":
        return yield* compileChild(this.#expressionTask(expression.expression, scope));
      case "identifier": {
        const entry = scope.resolve(expression.name);
        if (entry?.kind === "variable") return entry.variable.type;
        if (entry?.kind === "speaker" || (entry === undefined && expression.name === "speaker"))
          return { kind: "speaker" };
        return UNKNOWN_TYPE;
      }
      case "listLiteral":
      case "setLiteral": {
        let element: StaticType | undefined = NEVER_TYPE;
        for (const item of expression.elements) {
          const type = yield* compileChild(this.#expressionTask(item, scope));
          element = element === undefined ? undefined : joinTypes(element, type);
        }
        if (expression.elements.length === 0) element = openType();
        const kind = expression.kind === "listLiteral" ? "list" : "set";
        return { kind, element: element ?? UNKNOWN_TYPE };
      }
      case "objectLiteral": {
        const properties = new Map<string, StaticType>();
        for (const property of expression.properties) {
          const type = yield* compileChild(this.#expressionTask(property.value, scope));
          properties.set(property.name.name, placeType(type));
        }
        return { kind: "object", properties };
      }
      case "propertyAccessExpression": {
        const object = yield* compileChild(this.#expressionTask(expression.object, scope));
        return this.#propertyType(object, expression);
      }
      case "indexExpression": {
        const object = yield* compileChild(this.#expressionTask(expression.object, scope));
        const index = yield* compileChild(this.#expressionTask(expression.index, scope));
        this.#checkIndex(object, index, expression.index);
        const list = resolved(nonNullType(object));
        return list.kind === "list" ? list.element : UNKNOWN_TYPE;
      }
      case "callExpression":
        return yield* compileChild(this.#callTask(expression, scope));
      case "unaryExpression": {
        const operand = yield* compileChild(this.#expressionTask(expression.operand, scope));
        if (expression.operator === "not") {
          this.#requireBoolean(operand, expression.operand, "'not' needs true or false (boolean)");
          return BOOLEAN_TYPE;
        }
        return this.#operation(expression.operator, [operand], expression, (value) =>
          isNumeric(value) || isScalar(value, "duration") ? resolved(value) : undefined,
        );
      }
      case "binaryExpression":
        return yield* compileChild(this.#binaryTask(expression, scope));
      case "rangeExpression": {
        for (const bound of [expression.start, expression.end]) {
          const type = yield* compileChild(this.#expressionTask(bound, scope));
          this.#reportUnless(type, isNumeric(type), bound, "A range bound is a number");
        }
        return { kind: "range" };
      }
      case "interactionExpression":
        return yield* compileChild(this.#interactionTask(expression, scope));
      case "timerExpression":
        yield* compileChild(this.#timerTask(expression, scope));
        return expression.async ? { kind: "timer" } : UNKNOWN_TYPE;
      case "playMediaExpression":
        return yield* compileChild(this.#mediaTask(expression, scope, null));
      case "loadExpression":
        yield* compileChild(this.#storageKeyTask(expression.key, scope));
        if (expression.defaultValue !== null)
          yield* compileChild(this.#expressionTask(expression.defaultValue, scope));
        return UNKNOWN_TYPE;
    }
  }

  *#binaryTask(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
    scope: Scope,
  ): CompileTask<StaticType> {
    const left = yield* compileChild(this.#expressionTask(expression.left, scope));
    const right = yield* compileChild(this.#expressionTask(expression.right, scope));
    switch (expression.operator) {
      case "and":
      case "or":
        this.#requireBoolean(
          left,
          expression.left,
          `'${expression.operator}' needs true or false (boolean) values`,
        );
        this.#requireBoolean(
          right,
          expression.right,
          `'${expression.operator}' needs true or false (boolean) values`,
        );
        return BOOLEAN_TYPE;
      case "==":
      case "!=":
        return BOOLEAN_TYPE;
      case "<":
      case "<=":
      case ">":
      case ">=":
        this.#operation(expression.operator, [left, right], expression, (a, b) =>
          (isNumeric(a) && isNumeric(b)) ||
          (isScalar(a, "string") && isScalar(b, "string")) ||
          (isScalar(a, "duration") && isScalar(b, "duration"))
            ? BOOLEAN_TYPE
            : undefined,
        );
        return BOOLEAN_TYPE;
      default:
        return this.#operation(expression.operator, [left, right], expression, (a, b) =>
          arithmeticType(expression.operator, a, b),
        );
    }
  }

  /**
   * The result of an operator on known operand types: every combination of their members must be supported (ADR 0021
   * rule 3.5). Possibly null operands act on their other members (V30 §34). An unknown operand gives an unknown result.
   */
  #operation(
    operator: string,
    operands: readonly StaticType[],
    expression: Extract<Expression, { kind: "unaryExpression" | "binaryExpression" }>,
    result: (...values: StaticType[]) => StaticType | undefined,
  ): StaticType {
    const values = operands.map((operand) => resolved(nonNullType(operand)));
    if (values.some((value) => value.kind === "unknown" || value.kind === "open"))
      return UNKNOWN_TYPE;
    if (values.some((value) => value.kind === "never")) return UNKNOWN_TYPE;
    const results: StaticType[] = [];
    for (const left of members(values[0]!)) {
      for (const right of values.length > 1 ? members(values[1]!) : [left]) {
        const type = values.length > 1 ? result(left, right) : result(left);
        if (type === undefined) {
          this.#report(
            typeCode.invalidOperand,
            operatorMessage(operator, expression, values.length > 1 ? [left, right] : [left]),
            expression.span,
          );
          return UNKNOWN_TYPE;
        }
        results.push(type);
      }
    }
    return joinTypes(...results) ?? UNKNOWN_TYPE;
  }

  *#callTask(expression: CallExpression, scope: Scope): CompileTask<StaticType> {
    let callee = expression.callee;
    while (callee.kind === "parenthesizedExpression") callee = callee.expression;
    if (callee.kind === "identifier") {
      const entry = scope.resolve(callee.name);
      if (entry?.kind === "function")
        return yield* compileChild(this.#functionCallTask(expression, entry.fn, scope));
      const values: StaticType[] = [];
      for (const argument of expression.arguments)
        values.push(yield* compileChild(this.#expressionTask(argument.value, scope)));
      if (entry === undefined && this.#builtins.has(callee.name))
        return this.#builtinType(callee.name, expression, values);
      return UNKNOWN_TYPE;
    }
    if (callee.kind !== "propertyAccessExpression") {
      yield* compileChild(this.#expressionTask(callee, scope));
      for (const argument of expression.arguments)
        yield* compileChild(this.#expressionTask(argument.value, scope));
      return UNKNOWN_TYPE;
    }
    const receiver = yield* compileChild(this.#expressionTask(callee.object, scope));
    const method = callee.property.name;
    const value = resolved(nonNullType(receiver));
    if ((value.kind === "list" || value.kind === "set") && method === "add") {
      const argument = expression.arguments[0];
      if (argument !== undefined && expression.arguments.length === 1) {
        const type = yield* compileChild(this.#expressionTask(argument.value, scope));
        yield* compileChild(
          this.#storeTask(
            elementPlace(value, expressionLabel(callee.object), isNullable(receiver)),
            argument.value,
            type,
          ),
        );
        return NULL_TYPE;
      }
    }
    for (const argument of expression.arguments)
      yield* compileChild(this.#expressionTask(argument.value, scope));
    if (value.kind === "list" || value.kind === "set") {
      switch (method) {
        case "contains":
          return BOOLEAN_TYPE;
        case "toSet":
          return value.kind === "list" ? { kind: "set", element: value.element } : UNKNOWN_TYPE;
        case "toList":
          return value.kind === "set" ? { kind: "list", element: value.element } : UNKNOWN_TYPE;
        case "add":
        case "remove":
        case "removeFirst":
        case "removeLast":
        case "clear":
          return NULL_TYPE;
      }
      this.#report(
        typeCode.invalidOperand,
        `${value.kind === "list" ? "Lists" : "Sets"} have no method '${method}'.`,
        callee.property.span,
      );
      return UNKNOWN_TYPE;
    }
    if (value.kind === "timer" || value.kind === "media") return NULL_TYPE;
    if (value.kind !== "unknown" && value.kind !== "open" && value.kind !== "never")
      this.#report(
        typeCode.invalidOperand,
        `${capitalize(describeValue(value))} has no method '${method}'.`,
        callee.property.span,
      );
    return UNKNOWN_TYPE;
  }

  /** Argument and result types of the implemented built-ins; injected host functions return unknown values. */
  #builtinType(
    name: string,
    expression: CallExpression,
    values: readonly StaticType[],
  ): StaticType {
    const argument = expression.arguments[0];
    const value = values[0];
    switch (name) {
      case "random":
        return NUMBER_TYPE;
      case "chance":
        if (argument !== undefined && value !== undefined)
          this.#reportUnless(
            value,
            isNumeric(value),
            argument.value,
            "chance(...) takes a percentage number",
          );
        return BOOLEAN_TYPE;
      case "randomInteger":
        if (argument !== undefined && value !== undefined)
          this.#reportUnless(
            value,
            resolved(value).kind === "range",
            argument.value,
            "randomInteger(...) takes a range such as 1..=6",
          );
        return INTEGER_TYPE;
      case "round":
      case "floor":
      case "ceil":
        if (argument !== undefined && value !== undefined)
          this.#reportUnless(
            value,
            isNumeric(value),
            argument.value,
            `${name}(...) takes a number`,
          );
        return INTEGER_TYPE;
      case "escapeMarkup":
        if (argument !== undefined && value !== undefined)
          this.#reportUnless(
            value,
            isScalar(value, "string"),
            argument.value,
            "escapeMarkup(...) takes text (string)",
          );
        return STRING_TYPE;
      default:
        return UNKNOWN_TYPE;
    }
  }

  #propertyType(
    object: StaticType,
    expression: Extract<Expression, { kind: "propertyAccessExpression" }>,
  ): StaticType {
    const value = resolved(nonNullType(object));
    const name = expression.property.name;
    switch (value.kind) {
      case "list":
      case "set":
        if (name === "length") return INTEGER_TYPE;
        if (name === "first" || name === "last" || name === "random") return value.element;
        this.#report(
          typeCode.invalidOperand,
          `${value.kind === "list" ? "Lists" : "Sets"} have no property '${name}'; use length, first, last, or random.`,
          expression.property.span,
        );
        return UNKNOWN_TYPE;
      case "object":
        return value.properties?.get(name) ?? UNKNOWN_TYPE;
      case "timer":
      case "media":
        return handlePropertyType(value.kind, name, "read") ?? UNKNOWN_TYPE;
      case "scalar":
      case "range":
      case "null":
        this.#report(
          typeCode.invalidOperand,
          `${capitalize(describeValue(value))} has no property '${name}'.`,
          expression.property.span,
        );
        return UNKNOWN_TYPE;
      default:
        return UNKNOWN_TYPE;
    }
  }

  #checkIndex(object: StaticType, index: StaticType, expression: Expression): void {
    const value = resolved(nonNullType(object));
    if (value.kind !== "unknown" && value.kind !== "open" && value.kind !== "list") {
      this.#report(
        typeCode.invalidOperand,
        `Only a list can be indexed, but this is ${describeValue(value)}.`,
        expression.span,
      );
      return;
    }
    if (isScalar(index, "number"))
      this.#report(
        typeCode.invalidOperand,
        `A list index must be a whole number (integer), but this is ${describeValue(index)}.${ROUND_FIX}.`,
        expression.span,
      );
    else
      this.#reportUnless(
        index,
        isScalar(index, "integer"),
        expression,
        "A list index is a whole number (integer)",
      );
  }

  *#interactionTask(
    expression: Extract<Expression, { kind: "interactionExpression" }>,
    scope: Scope,
  ): CompileTask<StaticType> {
    if (expression.hint !== null) yield* compileChild(this.#expressionTask(expression.hint, scope));
    if (expression.defaultValue !== null && expression.interactionKind !== "choice") {
      const type = yield* compileChild(this.#expressionTask(expression.defaultValue, scope));
      this.#checkInteractionDefault(expression.interactionKind, expression.defaultValue, type);
    }
    for (const option of expression.options)
      yield* compileChild(this.#expressionTask(option.value, scope));
    if (expression.interactionKind === "number") return NUMBER_TYPE;
    if (expression.interactionKind === "text") return STRING_TYPE;
    return expression.options[0]?.label?.kind === "numberLiteral" ? NUMBER_TYPE : STRING_TYPE;
  }

  /**
   * A default answer must be an answer the field accepts: text for askText, a number for askNumber. The compiler rejects
   * a default it knows is wrong; the runtime checks the others when the field opens.
   */
  #checkInteractionDefault(
    kind: "text" | "number",
    expression: Expression,
    type: StaticType,
  ): void {
    const name = expression.kind === "identifier" ? expression.name : null;
    const holds = !isKnown(type)
      ? ""
      : name === null
        ? `, not ${describeValue(type)}`
        : `, but '${name}' holds ${describeValue(type)}`;
    const fix =
      resolved(type).kind === "null"
        ? EMPTY_FIELD_FIX
        : kind === "number"
          ? numberDefaultFix(expression)
          : textDefaultFix(expression, name);
    if (kind === "number") {
      if (!isAssignable(NUMBER_TYPE, type))
        this.#report(
          typeCode.invalidInteractionDefault,
          `The default answer of askNumber must be a number${holds}.${fix}`,
          expression.span,
        );
      return;
    }
    if (!isAssignable(STRING_TYPE, type) || isArithmetic(expression)) {
      this.#report(
        typeCode.invalidInteractionDefault,
        `The default answer of askText must be text${holds}.${fix}`,
        expression.span,
      );
      return;
    }
    const text = staticVisibleText(expression);
    if (text !== undefined && isBlankTextAnswer(text))
      this.#report(
        typeCode.invalidInteractionDefault,
        `The default answer of askText must contain a non-whitespace character.${EMPTY_FIELD_FIX}`,
        expression.span,
      );
  }

  // Commands ---------------------------------------------------------------------------------------------------------

  /** A time in a command that expects one: a duration, or a number of seconds; with an explicit unit, a number. */
  *#timeTask(expression: Expression, unit: boolean, scope: Scope): CompileTask<StaticType> {
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    if (unit)
      this.#reportUnless(type, isNumeric(type), expression, "A time before a unit is a number");
    else
      this.#reportUnless(
        type,
        isNumeric(type) || isScalar(type, "duration"),
        expression,
        "A time is a duration such as '30 s', or a number of seconds",
      );
    return type;
  }

  *#timerTask(timer: TimerParts, scope: Scope): CompileTask<void> {
    if (typeof timer.display === "object" && timer.display !== null)
      yield* compileChild(
        this.#requireTask(
          timer.display,
          scope,
          (type) => isScalar(type, "string"),
          "A timer display is text (string)",
        ),
      );
    if (unwrap(timer.duration).kind === "rangeExpression")
      yield* compileChild(this.#expressionTask(timer.duration, scope));
    else yield* compileChild(this.#timeTask(timer.duration, timer.unit !== null, scope));
    if (timer.label !== null)
      yield* compileChild(
        this.#requireTask(
          timer.label,
          scope,
          (type) => isScalar(type, "string"),
          "A timer label is text (string)",
        ),
      );
    if (timer.handler !== null) this.#handlers.push({ block: timer.handler, selfHandle: null });
  }

  *#mediaTask(media: MediaParts, scope: Scope, selfHandle: string | null): CompileTask<StaticType> {
    for (const operand of mediaOperands(media)) {
      if (operand === media.file)
        yield* compileChild(
          this.#fileTask(operand, scope, media.media === "audio" ? "playAudio" : "playVideo"),
        );
      else if (operand === media.volume)
        yield* compileChild(
          this.#requireTask(operand, scope, isNumeric, "Volume is a number from 0 through 1"),
        );
      else if (media.repeat?.kind === "times" && operand === media.repeat.count)
        yield* compileChild(
          this.#requireTask(
            operand,
            scope,
            (type) => isScalar(type, "integer"),
            "A repeat count is a whole number (integer)",
          ),
        );
      else if (media.repeat?.kind === "value" && operand === media.repeat.value)
        yield* compileChild(
          this.#requireTask(
            operand,
            scope,
            (type) => isScalar(type, "boolean", "duration"),
            "Repeat is true, false, or a duration",
          ),
        );
      else yield* compileChild(this.#timeTask(operand, false, scope));
    }
    for (const block of mediaHandlerBlocks(media))
      this.#handlers.push({ block, selfHandle: media.async ? selfHandle : null });
    return media.async ? { kind: "media" } : UNKNOWN_TYPE;
  }

  *#fileTask(expression: Expression, scope: Scope, command: string): CompileTask<void> {
    yield* compileChild(
      this.#requireTask(
        expression,
        scope,
        (type) =>
          members(type).every(
            (member) => isScalar(member, "string") || resolved(member).kind === "null",
          ),
        `${command} needs a file reference in text (string) or null`,
      ),
    );
  }

  *#storageKeyTask(expression: Expression, scope: Scope): CompileTask<void> {
    yield* compileChild(
      this.#requireTask(
        expression,
        scope,
        (type) => isScalar(type, "string"),
        "A storage key is text (string)",
      ),
    );
  }

  /** Checks a condition: it must be true or false; there is no truthiness. */
  *#conditionTask(expression: Expression, scope: Scope): CompileTask<void> {
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    this.#requireBoolean(type, expression, "A condition must be true or false (boolean)");
  }

  *#requireTask(
    expression: Expression,
    scope: Scope,
    accepts: (type: StaticType) => boolean,
    rule: string,
  ): CompileTask<void> {
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    this.#reportUnless(type, accepts(nonNullTypeForUse(type)), expression, rule);
  }

  // Reports ----------------------------------------------------------------------------------------------------------

  /** Conditions and `and`/`or`/`not` operands must be true or false; there is no truthiness. */
  #requireBoolean(type: StaticType, expression: Expression, rule: string): void {
    const value = nonNullTypeForUse(type);
    if (isScalar(value, "boolean") || !isKnown(value)) return;
    this.#report(
      typeCode.invalidOperand,
      `${rule}, but this is ${describeValue(value)}.${conditionFix(value, expression)}`,
      expression.span,
    );
  }

  /** Reports `rule` when a known value does not satisfy it. */
  #reportUnless(type: StaticType, satisfied: boolean, expression: Expression, rule: string): void {
    if (satisfied || !isKnown(nonNullTypeForUse(type))) return;
    this.#report(
      typeCode.invalidOperand,
      `${rule}, but this is ${describeValue(nonNullTypeForUse(type))}.`,
      expression.span,
    );
  }

  #report(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push(createDiagnostic(DiagnosticSeverity.Error, code, message, span));
  }
}

// Places -------------------------------------------------------------------------------------------------------------

function variablePlace(variable: Variable): Place {
  const name = variable.name;
  const type = variable.type;
  return {
    type,
    label: name,
    subject: `'${name}' holds ${describeValue(type)}${decidedAt(type)}`,
    verb: "be set to",
    fix: (rejected, expression) => typeFix(name, type, rejected, expression),
  };
}

function elementPlace(
  collection: StaticType & { readonly kind: "list" | "set" },
  name: string | null,
  nullable: boolean,
): Place {
  const subject = name === null ? `This ${collection.kind}` : `'${name}'`;
  const element = resolved(collection.element);
  return {
    type: collection.element,
    label: null,
    elementOf: name,
    subject:
      element.kind === "open"
        ? `${subject} holds a ${collection.kind}`
        : `${subject} holds ${typeName(element)} values (${typeName(collection)})${decidedAt(collection.element)}`,
    verb: "contain",
    fix: (value) => elementFix(name, collection, value, nullable),
  };
}

/** The place of a property inside a stored object literal, named after the place that keeps the object. */
function nestedPropertyPlace(type: StaticType, owner: Place, name: string): Place {
  if (owner.label !== null)
    return propertyPlace(type, `${owner.label}.${name}`, `'${owner.label}.${name}'`);
  const subject =
    owner.elementOf === undefined || owner.elementOf === null
      ? `Property '${name}'`
      : `Property '${name}' of the elements of '${owner.elementOf}'`;
  return propertyPlace(type, null, subject);
}

function propertyPlace(type: StaticType, label: string | null, name: string): Place {
  return {
    type,
    label,
    subject: `${name} holds ${describeValue(type)}${decidedAt(type)}`,
    verb: "be set to",
    fix: (value, expression) => {
      const conversion = conversionFix(type, value, expression);
      return conversion ?? " Use a separate property for a value of another type.";
    },
  };
}

/** `' from line 3'` when the first value stored decided the type, so the message names both places. */
function decidedAt(type: StaticType): string {
  const slot = findDecidedSlot(type);
  return slot === null ? "" : ` since line ${slot.start.line + 1}`;
}

function findDecidedSlot(type: StaticType): SourceSpan | null {
  if (type.kind === "open") return type.resolvedAt;
  if (type.kind === "union")
    for (const member of type.members) if (member.kind === "open") return member.resolvedAt;
  return null;
}

// Types of new places --------------------------------------------------------------------------------------------------

/** The value type of a timer or media handle property, or `undefined` when it cannot be read or assigned. */
function handlePropertyType(
  handle: "timer" | "media",
  name: string,
  use: "read" | "assign",
): StaticType | undefined {
  if (handle === "timer") {
    switch (name) {
      case "remaining":
        return DURATION_TYPE;
      case "elapsed":
        return use === "read" ? DURATION_TYPE : undefined;
      case "display":
        return STRING_TYPE;
      case "label":
        return use === "read" ? optional(STRING_TYPE) : undefined;
      case "state":
        return use === "read" ? STRING_TYPE : undefined;
      case "repeatDuration":
        return use === "read" ? optional(DURATION_TYPE) : DURATION_TYPE;
    }
    return undefined;
  }
  switch (name) {
    case "position":
      return DURATION_TYPE;
    case "elapsed":
      return use === "read" ? DURATION_TYPE : undefined;
    case "remaining":
      return use === "read" ? optional(DURATION_TYPE) : DURATION_TYPE;
    case "duration":
      return use === "read" ? optional(DURATION_TYPE) : undefined;
    case "volume":
      return NUMBER_TYPE;
    case "state":
      return use === "read" ? STRING_TYPE : undefined;
  }
  return undefined;
}

// Messages ------------------------------------------------------------------------------------------------------------

/** Operations on a possibly null value act on its other members (V30 §34); a value that is only null stays null. */
function nonNullTypeForUse(type: StaticType): StaticType {
  const value = nonNullType(type);
  return value.kind === "never" ? resolved(type) : value;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

/** Arithmetic yields a number or a duration, never text, even when its operand types are unknown. */
function isArithmetic(expression: Expression): boolean {
  const node = unwrap(expression);
  return (
    node.kind === "unaryExpression" ||
    (node.kind === "binaryExpression" && ARITHMETIC_OPERATORS.has(node.operator))
  );
}

const EMPTY_FIELD_FIX = " Remove 'default:' to start with an empty field.";

/** How to offer a non-text default as text: interpolate it explicitly. */
function textDefaultFix(expression: Expression, name: string | null): string {
  if (name !== null) return ` Write it as text: 'default: "\${${name}}"'.`;
  const literal = unwrap(expression);
  if (literal.kind === "numberLiteral")
    return ` Write it as text: 'default: "${numberAnswerText(literal.value)}"'.`;
  return " Write it as text with interpolation: 'default: \"${...}\"'.";
}

/** How to offer a number default: write number text as a number. */
function numberDefaultFix(expression: Expression): string {
  const text = staticVisibleText(expression);
  return text !== undefined && isValidInteractionPrefill("number", text)
    ? ` Write it as a number: 'default: ${text.trim()}'.`
    : " Use a number, such as 'default: 10'.";
}

function unwrap(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

/** The source spelling of a variable or property path, such as `items` or `door.keys`. */
function expressionLabel(expression: Expression): string | null {
  expression = unwrap(expression);
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "propertyAccessExpression") {
    const object = expressionLabel(expression.object);
    return object === null ? null : `${object}.${expression.property.name}`;
  }
  return null;
}

function operatorMessage(
  operator: string,
  expression: Extract<Expression, { kind: "unaryExpression" | "binaryExpression" }>,
  operands: readonly StaticType[],
): string {
  const [left, right] = operands;
  if (operands.length === 1)
    return `'${operator}' needs a number or a duration, but this is ${describeValue(left!)}.`;
  const text = (type: StaticType): boolean => isScalar(type, "string");
  const duration = (type: StaticType): boolean => isScalar(type, "duration");
  if (["<", "<=", ">", ">="].includes(operator))
    return `'${operator}' compares two numbers, two texts, or two durations, but these are ${describeValue(left!)} and ${describeValue(right!)}.`;
  if (operator === "+" && (text(left!) || text(right!)))
    return `'+' does not join text. Put the values in one text instead, such as "\${first}\${second}".`;
  if ((duration(left!) && isNumeric(right!)) || (isNumeric(left!) && duration(right!))) {
    const number =
      expression.kind === "binaryExpression"
        ? isNumeric(left!)
          ? expression.left
          : expression.right
        : null;
    return `A duration and a number cannot be combined with '${operator}'. ${unitFix(number)}`;
  }
  return `'${operator}' cannot combine ${describeValue(left!)} and ${describeValue(right!)}.`;
}

/** Give a bare number a unit: `'5 s'` for a literal, else multiplication by one second. */
function unitFix(number: Expression | null): string {
  const literal = number === null ? null : unwrap(number);
  if (literal?.kind === "numberLiteral")
    return `Give the number a unit, such as '${literal.raw} s'.`;
  const label = number === null ? null : expressionLabel(number);
  return `Give the number a unit, such as '${label ?? "n"} * 1 s'.`;
}

/** How to make an operand fit `+=`/`-=` on a place of `operand` type. */
function operandFix(operand: StaticType, value: Expression): string {
  if (isNumeric(operand)) return " Use a number instead.";
  if (isScalar(operand, "duration")) {
    const literal = unwrap(value);
    return literal.kind === "numberLiteral"
      ? ` Give the number a unit, such as '${literal.raw} s'.`
      : " Use a duration such as '2 s' instead.";
  }
  return "";
}

/** The fix for a number where a whole number is required; nothing truncates silently (ADR 0021 rule 2.2). */
const ROUND_FIX = " Round it with floor(...), round(...), or ceil(...)";

/** How to turn a value into the kind a place needs, when a conversion is the likely intent. */
function conversionFix(
  target: StaticType,
  value: StaticType,
  expression: Expression | null,
): string | undefined {
  const kept = resolved(nonNullType(target));
  if (isScalar(kept, "integer") && isScalar(value, "number")) return `${ROUND_FIX}.`;
  if (isScalar(kept, "duration") && isNumeric(value)) return ` ${unitFix(expression)}`;
  if (isScalar(kept, "string") && (isNumeric(value) || isScalar(value, "boolean"))) {
    const label =
      expression === null ? null : (expressionLabel(expression) ?? literalText(expression));
    return ` To show it as text, write "\${${label ?? "value"}}".`;
  }
  return undefined;
}

function literalText(expression: Expression): string | null {
  const literal = unwrap(expression);
  if (literal.kind === "numberLiteral") return literal.raw;
  if (literal.kind === "booleanLiteral") return String(literal.value);
  return null;
}

/** A short suggestion for the most common mismatches of a variable. */
function typeFix(
  name: string,
  target: StaticType,
  value: StaticType,
  expression: Expression | null,
): string {
  const nullable = isNullable(target);
  const kept = resolved(nonNullType(target));
  if (resolved(value).kind === "null" && !nullable)
    return isAnnotatable(target)
      ? ` To allow null, declare it as 'let ${name}: ${typeName(target)}? = ...'.`
      : " Use a separate variable for null.";
  if (isScalar(kept, "integer") && isScalar(value, "number"))
    return `${ROUND_FIX}, or declare it as 'let ${name}: number${nullable ? "?" : ""} = ...'.`;
  const conversion = conversionFix(target, value, expression);
  if (conversion !== undefined) return conversion;
  return " Use a separate variable for a value of another type.";
}

/** Like {@link typeFix}, for a parameter: a declaration in the function's parameter list. */
function parameterFix(
  name: string,
  target: StaticType,
  value: StaticType,
  expression: Expression | null,
  defaultValue?: Expression,
): string {
  const kept = resolved(nonNullType(target));
  if (isScalar(kept, "integer") && isScalar(value, "number")) {
    const declaration =
      defaultValue === undefined
        ? `${name}: number`
        : `${name}: number = ${sourceText(defaultValue) ?? "..."}`;
    return `${ROUND_FIX}, or declare the parameter as '${declaration}'.`;
  }
  return conversionFix(target, value, expression) ?? " Use a value of the parameter's type.";
}

function sourceText(expression: Expression): string | null {
  const literal = unwrap(expression);
  if (literal.kind === "numberLiteral") return literal.raw;
  if (literal.kind === "booleanLiteral") return String(literal.value);
  return null;
}

/** How a function with a declared result may also return null. */
function optionalResultFix(declared: StaticType): string {
  return isAnnotatable(declared)
    ? ` To allow null, declare the result as '${typeName(declared)}?'.`
    : "";
}

/** How to make a value fit a list or set: allow fractions, or keep other values in a separate collection. */
function elementFix(
  variable: string | null,
  collection: StaticType & { readonly kind: "list" | "set" },
  value: StaticType,
  nullable: boolean,
): string {
  if (variable !== null && isScalar(collection.element, "integer") && isScalar(value, "number"))
    return ` To allow fractions, declare it as 'let ${variable}: ${collection.kind === "list" ? "number[]" : "number set"}${nullable ? "?" : ""} = ...'.`;
  if (isScalar(collection.element, "duration") && isNumeric(value))
    return " Give the number a unit, such as '5 s'.";
  return ` Use a separate ${collection.kind} for values of another type.`;
}

/** How to turn a known non-boolean value into a condition. */
function conditionFix(value: StaticType, expression: Expression): string {
  const label = expressionLabel(expression);
  if (label === null) return "";
  if (isNumeric(value)) return ` Compare it instead, such as '${label} > 0'.`;
  if (isScalar(value, "string")) return ` Compare it instead, such as '${label} != ""'.`;
  const kind = resolved(value).kind;
  if (kind === "list" || kind === "set")
    return ` Check its length instead, such as '${label}.length > 0'.`;
  return "";
}
