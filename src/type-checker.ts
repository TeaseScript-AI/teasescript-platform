import type {
  AssignmentStatement,
  Block,
  CallExpression,
  Expression,
  FunctionDeclaration,
  Identifier,
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
import { staticChoiceValue, staticNumber, staticVisibleText } from "./static-evaluation.js";
import { MAX_INTERACTION_OPTION_ENTRIES } from "./interaction-limits.js";
import type { SourceSpan } from "./source.js";
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
  TypeJoin,
  members,
  misfitProperty,
  nonNullType,
  NULL_TYPE,
  NUMBER_TYPE,
  openType,
  optional,
  placeType,
  freshPlaceType,
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
  invalidInteractionChoice: "TSV029",
  invalidInteractionDefault: "TSV039",
  listInText: "TSV040",
  unshowableValue: "TSV042",
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
  /** The parameter types the declaration and defaults give. */
  parameters: readonly Variable[] | null;
  /**
   * The parameters as the body uses them: copies of `parameters` that the body may extend, for example with a property
   * it assigns. Arguments must fit these, so a property the body relies on cannot arrive with another type.
   */
  accepted: readonly Variable[] | null;
  result: StaticType | null;
  checking: boolean;
  /**
   * Calls reached while the function itself is checked, directly or through another function: their arguments, as
   * evaluated, are checked once its parameters and body are complete, together with the list literals they mix.
   */
  readonly pending: {
    readonly call: CallExpression;
    readonly values: readonly StaticType[];
    readonly literals: ReadonlyMap<Expression, readonly StaticType[]>;
  }[];
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

  /** One flag per enclosing loop: whether a reachable `break` leaves it. */
  readonly #loops: { broken: boolean; continued: boolean }[] = [];

  /** Whether the statement being checked can run; a `break` after a `return` does not end its loop. */
  #reachable = true;

  /**
   * List and set literals whose elements mix types, with those types. A literal stored in a place of a declared element
   * type is checked element by element instead; every other one is reported at the end of its statement (rule 1.3).
   */
  #mixedLiterals = new Map<Expression, readonly StaticType[]>();

  /** The variable names of unannotated `let` statements by initializer, for messages that suggest a declaration. */
  readonly #declaredBy = new Map<Expression, string>();

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
        accepted: null,
        result: null,
        checking: false,
        pending: [],
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
    for (const fn of this.#functions) runCompileTask(this.#functionResultTask(fn));
    for (let index = 0; index < this.#handlers.length; index += 1) {
      const handler = this.#handlers[index]!;
      const scope = new Scope(this.#root);
      if (handler.selfHandle !== null)
        scope.declare(handler.selfHandle, {
          kind: "variable",
          variable: { name: handler.selfHandle, type: { kind: "media" } },
        });
      this.#function = null;
      runCompileTask(this.#statementsTask(handler.block.statements, scope));
    }
  }

  // Statements -------------------------------------------------------------------------------------------------------

  /** Checks statements in order and returns whether execution can continue after them. */
  *#statementsTask(statements: readonly Statement[], scope: Scope): CompileTask<boolean> {
    let continues = true;
    const reachable = this.#reachable;
    for (const statement of statements) {
      this.#reachable = reachable && continues;
      if (!(yield* compileChild(this.#statementTask(statement, scope)))) continues = false;
    }
    this.#reachable = reachable;
    return continues;
  }

  *#blockTask(block: Block, scope: Scope): CompileTask<boolean> {
    return yield* compileChild(this.#statementsTask(block.statements, new Scope(scope)));
  }

  /** Checks one statement and returns whether execution can continue after it. */
  *#statementTask(statement: Statement, scope: Scope): CompileTask<boolean> {
    const continues = yield* compileChild(this.#statementKindTask(statement, scope));
    this.#reportMixedLiterals();
    return continues;
  }

  *#statementKindTask(statement: Statement, scope: Scope): CompileTask<boolean> {
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
        for (const property of statement.properties) {
          const type = yield* compileChild(this.#expressionTask(property.value, scope));
          if (SPEAKER_TEXT_PROPERTIES.has(property.name.name))
            this.#checkShownText(property.value, type, `the speaker's ${property.name.name}`);
        }
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
        this.#checkShownText(
          statement.label,
          yield* compileChild(this.#expressionTask(statement.label, scope)),
          "a button label",
        );
        if (statement.background !== null)
          this.#checkBackground(
            statement.background,
            yield* compileChild(this.#expressionTask(statement.background, scope)),
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
        this.#loops.push({ broken: false, continued: false });
        yield* compileChild(this.#blockTask(statement.body, scope));
        const { broken } = this.#loops.pop()!;
        const condition = unwrap(statement.condition);
        // `while true` without a `break` never ends normally.
        return broken || !(condition.kind === "booleanLiteral" && condition.value);
      }
      case "repeatStatement": {
        const count = nonNullTypeForUse(
          yield* compileChild(this.#expressionTask(statement.count, scope)),
        );
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
        this.#loops.push({ broken: false, continued: false });
        const repeats = yield* compileChild(this.#blockTask(statement.body, scope));
        const repeatExits = this.#loops.pop()!;
        // A loop that certainly runs ends normally only when an iteration can end: normally, by `continue`, or by
        // `break`.
        const times = staticNumber(statement.count);
        return (
          times === undefined || times < 1 || repeats || repeatExits.broken || repeatExits.continued
        );
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
        this.#loops.push({ broken: false, continued: false });
        const iterates = yield* compileChild(
          this.#statementsTask(statement.body.statements, loopScope),
        );
        const forExits = this.#loops.pop()!;
        return (
          !isNonEmptyLiteral(statement.iterable) ||
          iterates ||
          forExits.broken ||
          forExits.continued
        );
      }
      case "breakStatement": {
        const loop = this.#loops.at(-1);
        if (this.#reachable && loop !== undefined) loop.broken = true;
        return false;
      }
      case "continueStatement": {
        const loop = this.#loops.at(-1);
        if (this.#reachable && loop !== undefined) loop.continued = true;
        return false;
      }
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
      type = ownType(statement.initializer, value);
      if (initializer.kind === "listLiteral" || initializer.kind === "setLiteral")
        this.#declaredBy.set(initializer, name);
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
    /** A speaker text property shows its value as text. */
    let shownField: string | null = null;
    if (target.kind === "identifier") {
      const entry = scope.resolve(target.name);
      if (entry?.kind === "variable") place = variablePlace(entry.variable);
    } else {
      const object = yield* compileChild(this.#expressionTask(target.object, scope));
      if (target.kind === "indexExpression") {
        const index = yield* compileChild(this.#expressionTask(target.index, scope));
        this.#checkIndex(object, target.object, index, target.index);
        const list = resolved(nonNullType(object));
        if (list.kind === "list")
          place = elementPlace(list, expressionLabel(target.object), isNullable(object));
      } else {
        const value = resolved(nonNullType(object));
        const name = target.property.name;
        // A new property takes its type from its first value, by the same rule as `let` (rule 1.4).
        if (value.kind === "object" && value.properties !== null && !value.properties.has(name)) {
          const assigned = yield* compileChild(this.#expressionTask(statement.value, scope));
          if (statement.operator === "=")
            value.properties.set(
              name,
              decidedSlot(ownType(statement.value, assigned), statement.value.span),
            );
          return;
        }
        place = this.#propertyPlace(object, target.object, target.property);
        if (value.kind === "speaker" && SPEAKER_TEXT_PROPERTIES.has(name))
          shownField = `the speaker's ${name}`;
      }
    }
    const value = yield* compileChild(this.#expressionTask(statement.value, scope));
    if (shownField !== null) this.#checkShownText(statement.value, value, shownField);
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
   * object literal is checked part by part, so the message points at the element or property that does not fit. A
   * place that is only checked, such as a parameter at a call, keeps its type unchanged: `decides` is false.
   */
  *#storeTask(
    place: Place,
    expression: Expression,
    value: StaticType,
    decides = true,
  ): CompileTask<void> {
    const literal = unwrap(expression);
    const kept = resolved(nonNullType(place.type));
    if (
      (kept.kind === "list" && literal.kind === "listLiteral") ||
      (kept.kind === "set" && literal.kind === "setLiteral")
    ) {
      // A declared element type decides what the literal may mix (rule 1.3).
      if (resolved(kept.element).kind !== "open") this.#mixedLiterals.delete(literal);
      const elements = elementPlace(kept, place.label, isNullable(place.type));
      for (const element of literal.elements)
        yield* compileChild(this.#storeTask(elements, element, this.#typeOf(element), decides));
      return;
    }
    if (kept.kind === "object" && literal.kind === "objectLiteral" && kept.properties !== null) {
      const properties = kept.properties;
      const added: [string, StaticType][] = [];
      let fits = true;
      for (const property of literal.properties) {
        const known = properties.get(property.name.name);
        const type = this.#typeOf(property.value);
        if (known === undefined) {
          added.push([property.name.name, ownType(property.value, type)]);
          continue;
        }
        const before = this.diagnostics.length;
        yield* compileChild(
          this.#storeTask(
            nestedPropertyPlace(known, place, property.name.name),
            property.value,
            type,
            decides,
          ),
        );
        if (this.diagnostics.length > before) fits = false;
      }
      // New properties join the place only when the object fits it, so one mistake does not cause more.
      if (decides && fits) for (const [name, type] of added) properties.set(name, type);
      return;
    }
    if (isAssignable(place.type, value)) {
      if (decides) settle(place.type, value, expression.span);
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

  /** The place of a known property, or of a timer or media handle property, which must exist and be assignable. */
  #propertyPlace(
    object: StaticType,
    objectExpression: Expression,
    property: Identifier,
  ): Place | undefined {
    const value = resolved(nonNullType(object));
    const name = property.name;
    const label = `${expressionLabel(objectExpression) ?? "this object"}.${name}`;
    if (value.kind === "timer" || value.kind === "media") {
      const type = handlePropertyType(value.kind, name, "assign");
      if (type === undefined)
        this.#report(
          typeCode.invalidOperand,
          handleMemberMessage(value.kind, name, "assign"),
          property.span,
        );
      return type === undefined ? undefined : propertyPlace(type, label, `'${label}'`);
    }
    if (value.kind !== "object" || value.properties === null) return undefined;
    const type = value.properties.get(name);
    return type === undefined ? undefined : propertyPlace(type, label, `'${label}'`);
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

  /**
   * The result type of a function, checking its body the first time. A recursive call sees the declared result type,
   * or an unknown result while an unannotated result is still being inferred.
   */
  *#functionResultTask(fn: FunctionType): CompileTask<StaticType> {
    if (fn.result !== null) return fn.result;
    const declaration = fn.declaration;
    const declared =
      declaration.returnTypeAnnotation === null
        ? null
        : typeFromAnnotation(declaration.returnTypeAnnotation);
    if (fn.checking) return declared ?? UNKNOWN_TYPE;
    fn.checking = true;
    // A call in the middle of a statement checks the function; the statement's own literals are reported after it.
    const outerLiterals = this.#mixedLiterals;
    this.#mixedLiterals = new Map();
    const parameters = yield* compileChild(this.#parametersTask(fn));
    const scope = new Scope(this.#root);
    // The body works on its own copies, so checking an argument never changes what the body assumes.
    const accepted = parameters.map((parameter) => ({
      name: parameter.name,
      type: copyType(parameter.type),
    }));
    fn.accepted = accepted;
    for (const parameter of accepted)
      scope.declare(parameter.name, { kind: "variable", variable: parameter });
    const context: FunctionContext = { fn, declared, returns: [], returnsNull: false };
    const outer = this.#function;
    const outerLoops = this.#loops.splice(0);
    const outerReachable = this.#reachable;
    this.#function = context;
    this.#reachable = true;
    const continues = yield* compileChild(this.#statementsTask(declaration.body.statements, scope));
    this.#function = outer;
    this.#reachable = outerReachable;
    this.#loops.push(...outerLoops);
    for (const { call, values, literals } of fn.pending.splice(0)) {
      this.#mixedLiterals = new Map(literals);
      yield* compileChild(this.#argumentsTask(fn, call, values));
      this.#reportMixedLiterals();
    }
    this.#mixedLiterals = outerLiterals;
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

  /**
   * One type for every `return` value (ADR 0021 rule 1.5); a function that can end without a value may give null. A
   * return value of unknown type makes the result unknown, but the known values must still agree.
   */
  #inferredResult(context: FunctionContext): StaticType {
    const join = new TypeJoin();
    let first: { readonly type: StaticType; readonly span: SourceSpan } | undefined;
    for (const returned of context.returns) {
      if (resolved(returned.type).kind === "unknown") continue;
      first ??= returned;
      if (!join.add(returned.type))
        this.#report(
          typeCode.mixedTypes,
          `'${context.fn.declaration.name.name}' returns ${describeValue(returned.type)} here, but ${describeValue(first.type)} on line ${first.span.start.line + 1}. A function returns one type; use a separate function for values of another type.`,
          returned.span,
        );
    }
    if (context.returns.some((returned) => resolved(returned.type).kind === "unknown"))
      return UNKNOWN_TYPE;
    if (first === undefined) return NULL_TYPE;
    return context.returnsNull ? optional(join.type) : join.type;
  }

  /**
   * Parameter types: an annotation, else the type a default gives a `let` variable, else unknown. A part that the
   * default does not decide, such as the elements of `[]` or the type of `null`, stays unknown, because call sites
   * never decide a parameter's type.
   */
  *#parametersTask(fn: FunctionType): CompileTask<readonly Variable[]> {
    if (fn.parameters !== null) return fn.parameters;
    const parameters: Variable[] = [];
    fn.parameters = parameters;
    const scope = new Scope(this.#root);
    for (const parameter of fn.declaration.parameters) {
      const name = parameter.name.name;
      let type: StaticType = UNKNOWN_TYPE;
      if (parameter.typeAnnotation !== null) type = typeFromAnnotation(parameter.typeAnnotation);
      if (parameter.defaultValue !== null) {
        const value = yield* compileChild(this.#expressionTask(parameter.defaultValue, scope));
        if (parameter.typeAnnotation === null) type = decidedType(placeType(value));
        else {
          const declared = type;
          yield* compileChild(
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
    this.#reportMixedLiterals();
    return parameters;
  }

  /**
   * Checks the arguments of a call to an author function against its parameter types, which they do not change. A
   * call made while the function's body is checked is checked again once the body is complete.
   */
  *#functionCallTask(
    expression: CallExpression,
    fn: FunctionType,
    scope: Scope,
  ): CompileTask<StaticType> {
    const values: StaticType[] = [];
    for (const argument of expression.arguments) {
      const value = yield* compileChild(this.#expressionTask(argument.value, scope));
      // An argument is the value as it was evaluated: a later argument or the body may still add a property to an
      // object it was read from.
      values.push(isBorrowed(argument.value) ? copyType(value) : value);
    }
    // The body is checked before the arguments, so they must fit the parameters as the body uses them.
    const result = copyType(yield* compileChild(this.#functionResultTask(fn)));
    if (fn.checking)
      fn.pending.push({ call: expression, values, literals: this.#takeMixedLiterals(expression) });
    else yield* compileChild(this.#argumentsTask(fn, expression, values));
    return result;
  }

  /** Checks the evaluated arguments of a call against the function's parameters, which they do not change. */
  *#argumentsTask(
    fn: FunctionType,
    expression: CallExpression,
    values: readonly StaticType[],
  ): CompileTask<void> {
    const parameters = fn.accepted ?? (yield* compileChild(this.#parametersTask(fn)));
    const declarations = fn.declaration.parameters;
    let position = 0;
    for (const [argumentIndex, argument] of expression.arguments.entries()) {
      const index =
        argument.kind === "positionalArgument"
          ? position++
          : declarations.findIndex((parameter) => parameter.name.name === argument.name.name);
      const parameter = parameters[index];
      if (parameter === undefined) continue;
      const declaration = declarations[index]!;
      const name = fn.declaration.name.name;
      const place: Place = {
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
      };
      yield* compileChild(this.#storeTask(place, argument.value, values[argumentIndex]!, false));
    }
  }

  /** Removes the mixed list literals inside a call's arguments from those its statement reports, and returns them. */
  #takeMixedLiterals(expression: CallExpression): Map<Expression, readonly StaticType[]> {
    const taken = new Map<Expression, readonly StaticType[]>();
    const pending = expression.arguments.map((argument) => argument.value);
    while (pending.length > 0) {
      const node = unwrap(pending.pop()!);
      const types = this.#mixedLiterals.get(node);
      if (types !== undefined) {
        taken.set(node, types);
        this.#mixedLiterals.delete(node);
      }
      if (node.kind === "listLiteral" || node.kind === "setLiteral")
        for (const element of node.elements) pending.push(element);
      else if (node.kind === "objectLiteral")
        for (const property of node.properties) pending.push(property.value);
    }
    return taken;
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
            yield* compileChild(this.#interpolationTask(part.expression, scope));
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
        // The literal owns its element types: a variable's type inside it is copied (ADR 0014 copies values).
        const types: StaticType[] = [];
        for (const item of expression.elements) {
          const type = yield* compileChild(this.#expressionTask(item, scope));
          // The copy is the element as it was evaluated, also for a later check of this literal's parts.
          const owned = isBorrowed(item) ? copyType(type) : type;
          if (owned !== type) this.#types.set(item, owned);
          types.push(owned);
        }
        // Elements of known types must share one type; an element of unknown type leaves the element type unknown.
        const known = types.filter((type) => resolved(type).kind !== "unknown");
        let element = types.length === 0 ? openType() : joinTypes(known);
        if (element === undefined) this.#mixedLiterals.set(expression, known);
        if (element === undefined || known.length < types.length) element = UNKNOWN_TYPE;
        return { kind: expression.kind === "listLiteral" ? "list" : "set", element };
      }
      case "objectLiteral": {
        const properties = new Map<string, StaticType>();
        for (const property of expression.properties) {
          const type = yield* compileChild(this.#expressionTask(property.value, scope));
          // The copy is the value as it was evaluated, also for a later check of this literal's parts.
          const owned = isBorrowed(property.value) ? copyType(type) : type;
          if (owned !== type) this.#types.set(property.value, owned);
          properties.set(property.name.name, freshPlaceType(owned));
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
        this.#checkIndex(object, expression.object, index, expression.index);
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
    return joinTypes(results) ?? UNKNOWN_TYPE;
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
    const values: StaticType[] = [];
    for (const argument of expression.arguments)
      values.push(yield* compileChild(this.#expressionTask(argument.value, scope)));
    if (value.kind === "list" || value.kind === "set") {
      switch (method) {
        case "contains":
          return BOOLEAN_TYPE;
        case "toSet":
          return value.kind === "list" ? { kind: "set", element: value.element } : UNKNOWN_TYPE;
        case "toList":
          return value.kind === "set" ? { kind: "list", element: value.element } : UNKNOWN_TYPE;
        case "removeAt":
        case "removeFirst":
        case "removeLast":
          if (value.kind === "set") break;
          if (method === "removeAt" && values.length === 1)
            this.#checkIndex(value, callee.object, values[0]!, expression.arguments[0]!.value);
          // The removed element leaves the list, so its type is a copy for the place that keeps it.
          return copyType(value.element);
        case "add":
        case "remove":
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
    if (value.kind === "timer" || value.kind === "media") {
      if (!["pause", "resume", "stop"].includes(method))
        this.#report(
          typeCode.invalidOperand,
          handleMemberMessage(value.kind, method, "call"),
          callee.property.span,
        );
      else if (expression.arguments.length > 0)
        this.#report(
          typeCode.invalidOperand,
          `${value.kind === "timer" ? "Timer" : "Media"} ${method}() takes no arguments.`,
          callee.property.span,
        );
      return NULL_TYPE;
    }
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
      case "media": {
        const type = handlePropertyType(value.kind, name, "read");
        if (type === undefined)
          this.#report(
            typeCode.invalidOperand,
            handleMemberMessage(value.kind, name, "read"),
            expression.property.span,
          );
        return type ?? UNKNOWN_TYPE;
      }
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

  #checkIndex(
    object: StaticType,
    objectExpression: Expression,
    index: StaticType,
    expression: Expression,
  ): void {
    const value = resolved(nonNullType(object));
    if (value.kind !== "unknown" && value.kind !== "open" && value.kind !== "list") {
      this.#report(
        typeCode.invalidOperand,
        `Only a list can be indexed, but this is ${describeValue(value)}.`,
        objectExpression.span,
      );
      return;
    }
    const position = nonNullTypeForUse(index);
    if (isScalar(position, "number"))
      this.#report(
        typeCode.invalidOperand,
        `A list index must be a whole number (integer), but this is ${describeValue(position)}.${ROUND_FIX}.`,
        expression.span,
      );
    else
      this.#reportUnless(
        position,
        isScalar(position, "integer"),
        expression,
        "A list index is a whole number (integer)",
      );
  }

  *#interactionTask(
    expression: Extract<Expression, { kind: "interactionExpression" }>,
    scope: Scope,
  ): CompileTask<StaticType> {
    if (expression.hint !== null)
      this.#checkShownText(
        expression.hint,
        yield* compileChild(this.#expressionTask(expression.hint, scope)),
        "an input hint",
      );
    if (expression.interactionKind !== "choice") {
      if (expression.defaultValue !== null) {
        const type = yield* compileChild(this.#expressionTask(expression.defaultValue, scope));
        this.#checkInteractionDefault(expression.interactionKind, expression.defaultValue, type);
      }
      return expression.interactionKind === "number" ? NUMBER_TYPE : STRING_TYPE;
    }
    // `choose` returns a button's value: one written before `:`, or else what gives the button, with its type.
    const values: StaticType[] = [];
    let buttons = 0;
    for (const option of expression.options) {
      const content = unwrap(option.expression);
      const written: StaticType | null =
        option.value === null
          ? null
          : option.value.kind === "identifier"
            ? STRING_TYPE
            : option.value.numericType === "integer"
              ? INTEGER_TYPE
              : NUMBER_TYPE;
      if (content.kind === "listLiteral" || content.kind === "setLiteral") {
        // Each element gives one button; a set keeps one of equal members.
        buttons +=
          content.kind === "listLiteral"
            ? content.elements.length
            : new Set(content.elements.flatMap((element) => staticSetMember(element))).size;
        // The list or set is checked like any other: its elements share one type (ADR 0021 rule 1.3).
        yield* compileChild(this.#expressionTask(option.expression, scope));
        for (const element of content.elements) {
          const value = this.#choiceEntry(element, this.#typeOf(element), true);
          if (written === null) values.push(value);
        }
        // An empty list or set gives no buttons, so its written value is never returned.
        if (written !== null && content.elements.length > 0) values.push(written);
        continue;
      }
      const type = yield* compileChild(this.#expressionTask(option.expression, scope));
      const value = resolved(nonNullType(type));
      if (value.kind === "list" || value.kind === "set") {
        // The elements of a computed collection are not visible here: a choice object among them may return its
        // value or its text, so only scalar elements give a known result type.
        const element = resolved(value.element);
        values.push(
          written ?? (isNullable(type) || element.kind === "object" ? UNKNOWN_TYPE : value.element),
        );
        continue;
      }
      if (isKnown(value)) buttons += 1;
      const entry = this.#choiceEntry(option.expression, type, false);
      values.push(written ?? entry);
    }
    if (buttons > MAX_INTERACTION_OPTION_ENTRIES)
      this.#report(
        typeCode.invalidInteractionChoice,
        `A choice can show at most ${MAX_INTERACTION_OPTION_ENTRIES} buttons.`,
        expression.span,
      );
    // Integers and numbers together are numbers; values of other different types give a value of unknown type.
    return values.length === 0 ? UNKNOWN_TYPE : (joinTypes(values) ?? UNKNOWN_TYPE);
  }

  /**
   * Checks what gives one button: a value, or a choice object `{ value?, text, background? }` whose value, else its
   * text, the button returns. Returns that value's type; a computed choice object's value is not known.
   */
  #choiceEntry(entry: Expression, type: StaticType, inList: boolean): StaticType {
    const value = resolved(nonNullType(type));
    if (inList && (value.kind === "list" || value.kind === "set")) {
      this.#report(
        typeCode.invalidInteractionChoice,
        "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set.",
        entry.span,
      );
      return UNKNOWN_TYPE;
    }
    if (UNSHOWABLE_KINDS.has(value.kind) && value.kind !== "object") {
      this.#report(
        typeCode.invalidInteractionChoice,
        "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
        entry.span,
      );
      return UNKNOWN_TYPE;
    }
    const literal = unwrap(entry);
    if (literal.kind !== "objectLiteral") return value.kind === "object" ? UNKNOWN_TYPE : type;
    let returned: StaticType = UNKNOWN_TYPE;
    for (const property of literal.properties) {
      const propertyType = this.#typeOf(property.value);
      if (property.name.name === "text") {
        this.#checkShownText(property.value, propertyType, "the text of a choice option");
        if (!literal.properties.some((other) => other.name.name === "value"))
          returned = propertyType;
      } else if (property.name.name === "value") {
        if (UNSHOWABLE_KINDS.has(resolved(nonNullType(propertyType)).kind))
          this.#report(
            typeCode.invalidInteractionChoice,
            "A choice value must be text, a number, true, false, null, or a duration.",
            property.value.span,
          );
        returned = propertyType;
      } else if (property.name.name === "background")
        this.#checkBackground(property.value, propertyType);
    }
    return returned;
  }

  /** `${...}` shows a value, or one element of a list; a known value it cannot show is an error. */
  *#interpolationTask(expression: Expression, scope: Scope): CompileTask<void> {
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    const value = unwrap(expression);
    if (value.kind !== "listLiteral") {
      const shown = resolved(nonNullType(type));
      if (UNSHOWABLE_KINDS.has(shown.kind) && shown.kind !== "list")
        this.#report(
          typeCode.unshowableValue,
          `"\${...}" cannot show ${describeValue(shown)}. It shows text, numbers, true, false, null, and durations, and selects one element of a list.`,
          expression.span,
        );
      return;
    }
    if (value.elements.length === 0)
      this.#report(
        typeCode.unshowableValue,
        "An interpolated list must contain at least one element to select from.",
        value.span,
      );
    for (const element of value.elements)
      if (UNSHOWABLE_KINDS.has(resolved(nonNullType(this.#typeOf(element))).kind))
        this.#report(
          typeCode.unshowableValue,
          "An interpolated list may contain only text, numbers, true, false, null, and durations, because one element is shown as text.",
          element.span,
        );
  }

  /** A button background is a colour in text; `null` is no colour either, so an optional type is checked by its value. */
  #checkBackground(expression: Expression, type: StaticType): void {
    if (isKnown(nonNullType(type)) && !isScalar(nonNullType(type), "string"))
      this.#report(
        typeCode.invalidInteractionChoice,
        "Expected an opaque CSS button background colour.",
        expression.span,
      );
  }

  /** Only `${...}` selects from a list; a list in a text field is an error, at runtime when it is not known here. */
  #checkShownText(expression: Expression, type: StaticType, field: string): void {
    const value = resolved(nonNullType(type));
    if (value.kind === "list")
      this.#report(
        typeCode.listInText,
        `A list cannot be ${field}. Select one element with "\${list}" or list.random.`,
        expression.span,
      );
    else if (UNSHOWABLE_KINDS.has(value.kind))
      this.#report(
        typeCode.unshowableValue,
        `${capitalize(field)} cannot be ${describeValue(value)}.`,
        expression.span,
      );
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
    this.#reportTime(expression, type, unit);
    return type;
  }

  #reportTime(expression: Expression, type: StaticType, unit: boolean): void {
    if (unit)
      this.#reportUnless(type, isNumeric(type), expression, "A time before a unit is a number");
    else
      this.#reportUnless(
        type,
        isNumeric(type) || isScalar(type, "duration"),
        expression,
        "A time is a duration such as '30 s', or a number of seconds",
      );
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
    // A timer also accepts a range of whole seconds, written directly or held in a variable.
    const duration = yield* compileChild(this.#expressionTask(timer.duration, scope));
    if (resolved(nonNullType(duration)).kind !== "range")
      this.#reportTime(timer.duration, duration, timer.unit !== null);
    if (timer.label !== null)
      this.#checkShownText(
        timer.label,
        yield* compileChild(this.#expressionTask(timer.label, scope)),
        "a timer label",
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

  /** Reports list and set literals that mix types and were not stored in a place of a declared element type. */
  #reportMixedLiterals(): void {
    for (const [literal, types] of this.#mixedLiterals) {
      const kind = literal.kind === "setLiteral" ? "set" : "list";
      const first = types[0]!;
      const other = types.find((type) => joinTypes([first, type]) === undefined) ?? types[1]!;
      this.#report(
        typeCode.mixedTypes,
        `This ${kind} mixes ${mixDescription(first, other)}. A ${kind} holds one type; keep values of different types in separate ${kind}s.`,
        literal.span,
      );
    }
    this.#mixedLiterals.clear();
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

/** Value kinds that `${...}` cannot show. */
const UNSHOWABLE_KINDS: ReadonlySet<StaticType["kind"]> = new Set([
  "list",
  "set",
  "object",
  "range",
  "timer",
  "media",
  "speaker",
]);

/** Speaker properties shown as text: the display name and the parts it is derived from. */
const SPEAKER_TEXT_PROPERTIES: ReadonlySet<string> = new Set([
  "displayName",
  "title",
  "shortTitle",
  "firstName",
  "lastName",
]);

/** A set member known at compile time, or none when it is not known; a set keeps one of equal scalars. */
function staticSetMember(expression: Expression): (string | number | boolean | null)[] {
  const known = staticChoiceValue(expression)?.value;
  return known === undefined || (typeof known === "object" && known !== null) ? [] : [known];
}

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
  const names: string[] = [];
  let current = unwrap(expression);
  while (current.kind === "propertyAccessExpression") {
    names.push(current.property.name);
    current = unwrap(current.object);
  }
  if (current.kind !== "identifier") return null;
  names.push(current.name);
  return names.reverse().join(".");
}

/**
 * Whether an expression reads a value that another place holds, such as a variable or a property. A new place gets
 * its own copy of that value's type; the type of any other expression already belongs to the expression alone.
 */
function isBorrowed(expression: Expression): boolean {
  const node = unwrap(expression);
  return (
    node.kind === "identifier" ||
    node.kind === "propertyAccessExpression" ||
    node.kind === "indexExpression"
  );
}

/** A slot already decided by its first value at `at`, so a later mismatch can name that line. */
function decidedSlot(type: StaticType, at: SourceSpan): StaticType {
  // A place still undecided, such as one that so far took only null, is decided by its first other value instead.
  if (members(type).some((member) => member.kind === "open")) return type;
  const slot = openType();
  slot.resolved = type;
  slot.resolvedAt = at;
  return slot;
}

/** The type a new place keeps for the value of `expression` (rules 1.2–1.4), copied when another place holds it. */
function ownType(expression: Expression, type: StaticType): StaticType {
  return isBorrowed(expression) ? placeType(type) : freshPlaceType(type);
}

/** A literal list, set, or range that certainly has an element, so a loop over it runs at least once. */
function isNonEmptyLiteral(expression: Expression): boolean {
  const node = unwrap(expression);
  if (node.kind === "listLiteral" || node.kind === "setLiteral") return node.elements.length > 0;
  if (node.kind !== "rangeExpression") return false;
  const start = staticNumber(node.start);
  const end = staticNumber(node.end);
  return start !== undefined && end !== undefined && (node.inclusive ? end >= start : end > start);
}

/** Two kinds a literal mixes; for two objects, the property whose types differ. */
function mixDescription(first: StaticType, other: StaticType): string {
  const property = misfitProperty(first, other);
  if (property !== undefined)
    return `objects whose property '${property.name}' holds ${describeValue(property.kept)} in one and ${describeValue(property.value)} in another`;
  return `${describeValue(first)} and ${describeValue(other)}`;
}

/** The message for a timer or media handle member that does not exist or cannot be assigned. */
function handleMemberMessage(
  handle: "timer" | "media",
  name: string,
  use: "read" | "assign" | "call",
): string {
  const kind = handle === "timer" ? "Timer" : "Media";
  if (use === "call")
    return `${kind} handles have no method '${name}'; use pause(), resume(), or stop().`;
  if (use === "read") return `${kind} handles have no property '${name}'.`;
  return handle === "timer"
    ? `Timer handle property '${name}' cannot be assigned; assign remaining, display, or repeatDuration.`
    : `Media handle property '${name}' cannot be assigned; assign position, remaining, or volume.`;
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
