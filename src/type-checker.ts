import type {
  AssignmentStatement,
  Block,
  CallArgument,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionParameter,
  Identifier,
  LetStatement,
  MediaParts,
  Program,
  ScalarTypeName,
  ShowButtonParts,
  SwitchTypeTest,
  Statement,
  TimerParts,
  TypeAnnotation,
} from "./ast.js";
import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import {
  expressionChildren,
  mediaHandlerBlocks,
  mediaOperands,
  showButtonOptions,
} from "./expression-children.js";
import {
  isBlankTextAnswer,
  isValidInteractionPrefill,
  numberAnswerText,
} from "./interaction-answers.js";
import type { TypeCheckPlan } from "./plan/model.js";
import { CONVERSION_RESULTS } from "./conversions.js";
import {
  builtinCallProblems,
  COLLECTION_METHODS,
  collectionMethodProblems,
  memberProblems,
  type OperationProblem,
} from "./operation-checks.js";
import { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "./protected-names.js";
import { formatDuration } from "./duration.js";
import { staticChoiceValue, staticNumber, staticVisibleText } from "./static-evaluation.js";
import { MAX_INTERACTION_OPTION_ENTRIES } from "./interaction-limits.js";
import { impossibleCaseMessage } from "./switch-cases.js";
import type { SourceSpan } from "./source.js";
import { TEXT_MEMBERS, type TextMember } from "./text-operations.js";
import {
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  parseIsoTimestamp,
  type TemporalResult,
} from "./temporal.js";
import {
  arithmeticType,
  BOOLEAN_TYPE,
  containsType,
  copyType,
  coversType,
  DATE_TYPE,
  DATETIME_TYPE,
  decidedType,
  describeValue,
  DURATION_TYPE,
  elementStoreType,
  elementType,
  INTEGER_TYPE,
  isAnnotatable,
  isAssignable,
  isKnown,
  isNullable,
  isNumeric,
  isScalar,
  joinTypes,
  mayEqual,
  plainType,
  possibleValues,
  type PossibleValue,
  type ScalarValue,
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
  TIME_TYPE,
  TIMESTAMP_TYPE,
  typeFromAnnotation,
  typeName,
  union,
  withValues,
  UNKNOWN_TYPE,
  originsOf,
  ownOrigins,
  narrowTo,
  excludeType,
  assignedType,
  widenedType,
  widenPath,
  numberPaths,
  integerParts,
  ownPartOrigins,
  type Declaration,
  type Origin,
  type PartOrigin,
  type StaticType,
} from "./static-types.js";
import { typePlan } from "./type-plans.js";

export interface TypeCheckOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
}

export interface TypeCheckResult {
  readonly diagnostics: readonly Diagnostic[];
  /** The runtime checks of values the compiler cannot know, by the source of the instruction that stores them. */
  readonly runtimeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>;
}

/**
 * Where a value is stored in a place of known type: a `let` or assignment, a list or set `add` call, an argument of an
 * author function, a parameter default, or a `return`.
 */
export type RuntimeCheckSite =
  | LetStatement
  | AssignmentStatement
  | CallExpression
  | CallArgument
  | FunctionParameter
  | Extract<Statement, { kind: "returnStatement" }>;

const typeCode = {
  invalidSetElement: "TSV006",
  argumentCount: "TSV020",
  unknownNamedArgument: "TSV022",
  invalidInteractionChoice: "TSV029",
  invalidInteractionDefault: "TSV039",
  listInText: "TSV040",
  unshowableValue: "TSV042",
  constantTest: "TSV046",
  typeMismatch: "TSV041",
  invalidOperand: "TSV043",
  mixedTypes: "TSV044",
  impossibleCase: "TSV049",
} as const;

/**
 * Checks that every variable, list or set element, object property, function parameter, and function result keeps one
 * type, and that operations receive values they support (ADR 0021). It runs after name validation succeeded, so every
 * name resolves; a value it cannot know has the type `unknown` and is never rejected.
 */
export function checkTypes(program: Program, options: TypeCheckOptions = {}): TypeCheckResult {
  // An integer variable is a number when one of its assignments can store a non-whole number, also an assignment
  // after its uses (rule 1.2). A check that finds a new one starts again with that variable declared as a number, so
  // the last check, which finds none, sees every variable with its final type and alone reports.
  const widened: Widened = new Map();
  for (;;) {
    const checker = new TypeChecker(options, widened);
    checker.check(program);
    if (!checker.widenedMore)
      return Object.freeze({
        diagnostics: Object.freeze([...checker.diagnostics]),
        runtimeChecks: checker.runtimeChecks(),
      });
    checker.widenFollowers();
  }
}

/**
 * The variables, elements, and properties that one of their assignments gives a non-whole number, with the first such
 * assignment: by the declaration of the variable that holds them, then by their path in it (see {@link PlacePath}).
 */
type Widened = Map<Declaration, Map<string, SourceSpan>>;

/**
 * Where a place is inside a variable without a type annotation: the steps from the variable, each a property name or `[]`
 * for the elements of a list or set. The variable itself has no steps.
 */
interface PlacePath {
  readonly root: Declaration;
  readonly path: readonly string[];
}

function extendPath(owner: PlacePath | undefined, step: string): PlacePath | undefined {
  return owner === undefined ? undefined : { root: owner.root, path: [...owner.path, step] };
}

/** A place that stores a value of another place, so it widens with it (see `TypeChecker.#follow`). */
interface Follower {
  readonly place: PlacePath;
  readonly at: SourceSpan;
}

/** The place an origin stands for: a variable, or an element or property inside one. */
function originPlace(origin: Origin): PlacePath {
  return "root" in origin ? origin : { root: origin, path: [] };
}

/** A variable and the type it keeps. Open slots and object property tables inside `type` record later decisions. */
interface Variable {
  readonly name: string;
  readonly type: StaticType;
  /** For a variable without a type annotation, its declaration, so a non-whole number can widen its integer type. */
  readonly declaration?: Declaration | undefined;
  /** Whether a type is written for the variable: a `let` or parameter with a type annotation. */
  readonly annotated?: boolean;
  /** Whether a function or a timer or media block may assign it, so a call or suspension cancels its narrowing. */
  readonly shared: boolean;
}

/**
 * What a branch of the control flow changes: narrowed variable types that differ from where the branch began, with
 * `undefined` for a variable that has only its declared or inferred type again. `null` stands for a point that
 * execution cannot reach.
 */
type Changes = ReadonlyMap<Variable, StaticType | undefined>;

type Collection = Extract<StaticType, { kind: "list" | "set" }>;

/** What a condition changes when it is true and when it is false, from the flow before it. */
interface Branches {
  readonly type: StaticType;
  readonly whenTrue: Changes | null;
  readonly whenFalse: Changes | null;
}

/**
 * What reading a place gives: the type that a variable, property, or element itself keeps, which later stores may still
 * decide or extend. Every other expression gives a type that belongs to it alone.
 */
interface PlaceRead {
  readonly kind: "placeRead";
  readonly type: StaticType;
}

function placeRead(type: StaticType): PlaceRead {
  return { kind: "placeRead", type };
}

type Entry =
  | { readonly kind: "variable"; readonly variable: Variable }
  | { readonly kind: "speaker" }
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
  /** For a variable without a type annotation, its declaration: a non-whole number widens it instead of failing. */
  readonly widening?: PlacePath | undefined;
  /**
   * Whether no type is written for the place: a variable or parameter without an annotation, or a property or element
   * that one holds. Only a written union type keeps a `choose` of different value types (#511 C2).
   */
  readonly inferred?: "variable" | "part" | undefined;
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
  /**
   * The names of the script's top-level `let` variables and speakers, which function bodies may use before they are
   * declared.
   */
  readonly #scriptVariables = new Set<string>();
  /** Whether the script's top-level statements are checked, so every script variable has its type. */
  #scriptChecked = false;
  /** The names each function's parameters and body mention, found when first needed. */
  readonly #namesUsed = new Map<FunctionType, ReadonlySet<string>>();

  readonly #handlers: { readonly block: Block; readonly selfHandle: string | null }[] = [];

  #function: FunctionContext | null = null;

  readonly #types = new Map<Expression, StaticType>();

  /** The checked expressions whose kept type is still the type of the place they read. */
  readonly #placeReads = new Set<Expression>();

  /** The flows at the reachable `break` statements of each enclosing loop, and whether a `continue` is reachable. */
  readonly #loops: { readonly start: FlowState; breaks: Changes[]; continued: boolean }[] = [];

  /** The narrowed types at the current point of the checked code. */
  #flow = new Flow();

  /** What functions, blocks, and loops may change, collected before checking. */
  #effects: ProgramEffects = { shared: new Set(), loops: new Map() };

  /** Whether the statement being checked can run; a `break` after a `return` does not end its loop. */
  #reachable = true;

  /**
   * List and set literals whose elements mix types, with those types. A literal stored in a place of a declared element
   * type is checked element by element instead; every other one is reported at the end of its statement (rule 1.3).
   */
  #mixedLiterals = new Map<Expression, readonly StaticType[]>();
  /** `choose` expressions whose buttons return values of different types, which only a declared union may keep. */
  readonly #mixedChoices = new Map<Expression, StaticType>();

  /** The variable names of unannotated `let` statements by initializer, for messages that suggest a declaration. */
  readonly #declaredBy = new Map<Expression, string>();

  /** Stores of values the compiler cannot know, kept until every type they depend on is decided. */
  readonly #runtimeChecks: {
    readonly site: RuntimeCheckSite;
    readonly place: StaticType;
    readonly label: string;
  }[] = [];

  /** Whether this check found a variable to widen that earlier checks did not. */
  widenedMore = false;

  /** Widens every place that follows a widened one (see {@link #followers}). */
  public widenFollowers(): void {
    const pending: PlacePath[] = [];
    for (const [root, paths] of this.#widened)
      for (const path of paths.keys())
        pending.push({ root, path: path === "" ? [] : path.split(".") });
    while (pending.length > 0) {
      const widened = pending.pop()!;
      for (const { place, at } of this.#followers.get(widened.root)?.get(widened.path.join(".")) ??
        []) {
        if (this.#widenedAt(place.root, place.path)) continue;
        this.#recordWidening(place, at);
        pending.push(place);
      }
    }
  }

  readonly #widened: Widened;

  /**
   * For each integer place, by its variable and its path there, the integer places that store its value, with where:
   * when it widens, they widen too, without one more check per step of a chain.
   */
  readonly #followers = new Map<Declaration, Map<string, Follower[]>>();

  /** The variable each declaration created most recently, whose type later widenings change. */
  readonly #declared = new Map<Declaration, Variable>();

  /** One origin for each element or property inside a variable, so equal parts are one origin. */
  readonly #parts = new Map<Declaration, Map<string, PartOrigin>>();

  public constructor(options: TypeCheckOptions, widened: Widened) {
    this.#widened = widened;
    this.#builtins = new Set([
      ...CORE_RUNTIME_BUILTINS,
      ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
      ...(options.builtins ?? []),
    ]);
    // Host globals have no static type and cannot be assigned, but a test may narrow them.
    for (const name of options.globals ?? [])
      this.#root.declare(name, {
        kind: "variable",
        variable: { name, type: UNKNOWN_TYPE, shared: false },
      });
  }

  public check(program: Program): void {
    for (const statement of program.statements)
      if (statement.kind === "letStatement" || statement.kind === "speakerDeclaration")
        this.#scriptVariables.add(statement.name.name);
    this.#effects = programEffects(program);
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
    // Every script variable has its type now, so every function body is checked, also one that waited for one.
    this.#scriptChecked = true;
    for (const fn of this.#functions) runCompileTask(this.#functionResultTask(fn));
    for (let index = 0; index < this.#handlers.length; index += 1) {
      const handler = this.#handlers[index]!;
      const scope = new Scope(this.#root);
      if (handler.selfHandle !== null)
        scope.declare(handler.selfHandle, {
          kind: "variable",
          variable: { name: handler.selfHandle, type: { kind: "media" }, shared: false },
        });
      this.#function = null;
      // A block does not inherit narrowed facts from the code around it (rule 5.5).
      this.#flow = new Flow();
      runCompileTask(this.#statementsTask(handler.block.statements, scope));
    }
  }

  /**
   * The recorded runtime checks in plan form. Call it after {@link check}: a place can still be decided after a store
   * into it was checked, as by a later first value or a property that assignment adds.
   */
  public runtimeChecks(): ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> {
    const checks = new Map<RuntimeCheckSite, TypeCheckPlan>();
    for (const check of this.#runtimeChecks) {
      const type = typePlan(check.place);
      if (type !== null) checks.set(check.site, { type, place: check.label });
    }
    return checks;
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
        return true;
      case "sayStatement":
        yield* compileChild(this.#sayTask(statement, scope));
        this.#suspend();
        return true;
      case "showButtonStatement":
        yield* compileChild(this.#showButtonTask(statement, scope));
        this.#suspend();
        return true;
      case "waitStatement":
        yield* compileChild(this.#timeTask(statement.duration, statement.unit !== null, scope));
        this.#suspend();
        return true;
      case "timerStatement":
        yield* compileChild(this.#timerTask(statement, scope));
        this.#suspend();
        return true;
      case "playMediaStatement":
        yield* compileChild(this.#mediaTask(statement, scope, null));
        return true;
      case "showImageStatement":
        // The image waits for the previous message's pacing before its operand is evaluated.
        this.#suspend();
        yield* compileChild(this.#fileTask(statement.image, scope, "showImage"));
        this.#suspend();
        return true;
      case "hideImageStatement":
        this.#suspend();
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
        this.#suspend();
        return true;
      }
      case "deleteStatement":
        yield* compileChild(this.#storageKeyTask(statement.key, scope));
        this.#suspend();
        return true;
      case "ifStatement": {
        const condition = yield* compileChild(this.#conditionTask(statement.condition, scope));
        const start = this.#flow.mark();
        this.#flow.apply(condition.whenTrue);
        const thenContinues = yield* compileChild(
          this.#pathTask(statement.thenBlock, scope, condition.whenTrue !== null),
        );
        const thenEnd = this.#flow.mark();
        this.#flow.restore(start);
        this.#flow.apply(condition.whenFalse);
        const elseContinues =
          statement.elseBlock === null ||
          (yield* compileChild(
            this.#pathTask(statement.elseBlock, scope, condition.whenFalse !== null),
          ));
        const elseEnd = this.#flow.mark();
        // A branch that the condition never takes does not continue past the statement.
        const thenReached = thenContinues && condition.whenTrue !== null;
        const elseReached = elseContinues && condition.whenFalse !== null;
        if (thenReached && elseReached) {
          const paths = [this.#flow.between(start, thenEnd), this.#flow.between(start, elseEnd)];
          this.#flow.restore(start);
          this.#flow.apply(this.#flow.join(paths));
        } else {
          // The only path that continues keeps its flow as it is.
          this.#flow.restore(thenReached ? thenEnd : elseReached ? elseEnd : start);
        }
        return thenReached || elseReached;
      }
      case "switchStatement": {
        const subject = yield* compileChild(this.#expressionTask(statement.subject, scope));
        // The cases test the switched value in order, like an `if`/`else if` chain: only a plain variable narrows
        // (rule 5.4), each block sees what its case takes, and `default` sees what no case took.
        const node = unwrap(statement.subject);
        const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
        const variable = entry?.kind === "variable" ? entry.variable : null;
        let remaining = subject;
        const start = this.#flow.mark();
        const ends: FlowState[] = [];
        for (const switchCase of statement.cases) {
          // What the block may assume about the value, or `null` when the case does not narrow it.
          let taken: StaticType | null = null;
          let reached: boolean;
          if (switchCase.typeTest !== null) {
            const test = this.#annotationType(switchCase.typeTest.type);
            const passed = narrowTo(remaining, test);
            const failed = excludeType(remaining, test);
            taken = switchCase.typeTest.negated ? failed : passed;
            this.#warnNeverMatchingTypeCase(
              statement.subject,
              remaining,
              switchCase.typeTest,
              test,
              taken,
            );
            remaining = switchCase.typeTest.negated ? passed : failed;
            reached = taken.kind !== "never";
          } else {
            // The block is reached when one of its values can still match what the cases above left.
            let matchable = false;
            for (const value of switchCase.values) {
              const valueType = yield* compileChild(this.#expressionTask(value, scope));
              const message = impossibleCaseMessage(statement.subject, subject, value, valueType);
              // A value whose type can never match is an error, and it does not reach the block either.
              if (message !== undefined) {
                this.#report(typeCode.impossibleCase, message, value.span);
                continue;
              }
              const never = this.#neverMatchingCaseValue(
                statement.subject,
                remaining,
                value,
                valueType,
              );
              if (never === undefined) matchable = true;
              else
                this.diagnostics.push(
                  createDiagnostic(
                    DiagnosticSeverity.Warning,
                    typeCode.constantTest,
                    never,
                    value.span,
                  ),
                );
            }
            // A value case keeps what the cases above left, and `case null` narrows like `x == null`.
            reached = matchable;
            if (switchCase.values.every((value) => unwrap(value).kind === "nullLiteral")) {
              taken = narrowTo(remaining, NULL_TYPE);
              remaining = excludeType(remaining, NULL_TYPE);
            } else taken = remaining;
          }
          this.#flow.restore(start);
          if (variable !== null && taken !== null && reached)
            this.#flow.apply(this.#flow.since(start, new Map([[variable, taken]])));
          if ((yield* compileChild(this.#pathTask(switchCase.body, scope, reached))) && reached)
            ends.push(this.#flow.mark());
        }
        // `default`, or the path without one, runs when no case matched. A path that no value reaches does not continue.
        this.#flow.restore(start);
        const restReached = remaining.kind !== "never";
        if (variable !== null && restReached && remaining !== subject)
          this.#flow.apply(this.#flow.since(start, new Map([[variable, remaining]])));
        if (statement.defaultBlock === null) {
          if (restReached) ends.push(this.#flow.mark());
        } else if (
          (yield* compileChild(this.#pathTask(statement.defaultBlock, scope, restReached))) &&
          restReached
        )
          ends.push(this.#flow.mark());
        this.#flow.restore(start);
        if (ends.length === 1) this.#flow.restore(ends[0]!);
        else if (ends.length > 1)
          this.#flow.apply(this.#flow.join(ends.map((end) => this.#flow.between(start, end))));
        return ends.length > 0;
      }
      case "whileStatement": {
        // The condition is tested anew on each iteration, after whatever the body changed (rule 5.5).
        this.#widen(statement.body);
        const condition = yield* compileChild(this.#conditionTask(statement.condition, scope));
        const start = this.#flow.mark();
        this.#flow.apply(condition.whenTrue);
        this.#loops.push({ start, breaks: [], continued: false });
        yield* compileChild(this.#pathTask(statement.body, scope, condition.whenTrue !== null));
        const { breaks } = this.#loops.pop()!;
        this.#flow.restore(start);
        this.#flow.apply(this.#flow.join([condition.whenFalse, ...breaks]));
        // `while true` without a `break` never ends normally.
        return condition.whenFalse !== null || breaks.length > 0;
      }
      case "repeatStatement": {
        const counted = yield* compileChild(this.#expressionTask(statement.count, scope));
        const count = nonNullTypeForUse(counted);
        if (isScalar(count, "number"))
          this.#report(
            typeCode.invalidOperand,
            `A repeat count must be a whole number (integer), but this is ${describeValue(count)}.${this.#widenedNote(statement.count)}${ROUND_FIX}.`,
            statement.count.span,
          );
        else
          this.#reportUnless(
            counted,
            (member) => isScalar(member, "integer"),
            statement.count,
            "A repeat count is a whole number (integer)",
          );
        const ends = yield* compileChild(this.#loopBodyTask(statement.body, scope, null));
        // A loop that certainly runs once ends normally only when its body or a `break` does.
        const times = staticNumber(statement.count);
        return times === undefined || times < 1 || ends;
      }
      case "forStatement": {
        const iterable = yield* compileChild(this.#expressionTask(statement.iterable, scope));
        const element = elementType(iterable);
        this.#reportUnless(
          iterable,
          (member) => elementType(member) !== undefined,
          statement.iterable,
          "A for-loop goes through a list, a set, or a range",
        );
        // The loop variable is a place: it keeps the plain element type.
        const loopType = element === undefined ? UNKNOWN_TYPE : copyType(plainType(element));
        this.#follow({ root: statement, path: [] }, loopType, statement.iterable.span);
        const variable: Variable = {
          name: statement.variable.name,
          type: this.#ownType(statement, loopType),
          shared: false,
          declaration: statement,
        };
        this.#declared.set(statement, variable);
        const ends = yield* compileChild(this.#loopBodyTask(statement.body, scope, variable));
        return !isNonEmptyLiteral(statement.iterable) || ends;
      }
      case "breakStatement": {
        const loop = this.#loops.at(-1);
        if (this.#reachable && loop !== undefined) loop.breaks.push(this.#flow.since(loop.start));
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

  /**
   * A block that runs when a condition decides so, or an `else if`. A block the condition never selects is still
   * checked, but nothing in it, such as a `break`, can be reached.
   */
  *#pathTask(block: Block | Statement, scope: Scope, reached: boolean): CompileTask<boolean> {
    const reachable = this.#reachable;
    if (!reached) this.#reachable = false;
    const continues =
      block.kind === "block"
        ? yield* compileChild(this.#blockTask(block, scope))
        : yield* compileChild(this.#statementTask(block, scope));
    this.#reachable = reachable;
    return continues;
  }

  /**
   * The body of a `repeat` or `for` loop, which may run any number of times, including none. Returns whether the body
   * can end normally or leave through a `break`.
   */
  *#loopBodyTask(body: Block, scope: Scope, variable: Variable | null): CompileTask<boolean> {
    this.#widen(body);
    const start = this.#flow.mark();
    const loopScope = new Scope(scope);
    if (variable !== null) loopScope.declare(variable.name, { kind: "variable", variable });
    this.#loops.push({ start, breaks: [], continued: false });
    const continues = yield* compileChild(this.#statementsTask(body.statements, loopScope));
    const { breaks, continued } = this.#loops.pop()!;
    this.#flow.restore(start);
    // The body may also run no time at all.
    this.#flow.apply(this.#flow.join([new Map(), ...breaks]));
    return continues || continued || breaks.length > 0;
  }

  *#sayTask(
    statement: Extract<Statement, { kind: "sayStatement" }>,
    scope: Scope,
  ): CompileTask<void> {
    if (statement.presentation !== null)
      yield* compileChild(this.#expressionTask(statement.presentation, scope));
    yield* compileChild(this.#expressionTask(statement.value, scope));
    if (statement.pacing !== null && statement.pacing !== "instant")
      yield* compileChild(
        this.#requireTask(statement.pacing, scope, isNumeric, "Say pacing is a number of seconds"),
      );
  }

  *#letTask(statement: LetStatement, scope: Scope): CompileTask<void> {
    const name = statement.name.name;
    const initializer = unwrap(statement.initializer);
    if (statement.typeAnnotation === null) this.#declaredBy.set(initializer, name);
    const value =
      initializer.kind === "playMediaExpression"
        ? yield* compileChild(this.#mediaTask(initializer, scope, name))
        : yield* compileChild(this.#expressionTask(statement.initializer, scope));
    let type: StaticType;
    if (statement.typeAnnotation === null) {
      type = this.#newPlaceType(statement.initializer, value);
      // A number this variable holds derives from the variable itself, which follows what its first value derives
      // from (rule 1.2).
      this.#follow({ root: statement, path: [] }, value, statement.initializer.span);
      type = this.#ownType(statement, type);
      this.#reportMixedChoice(
        statement.initializer,
        (written) =>
          `to keep both, declare a union type, as in 'let ${name}: ${written} = choose ...'`,
      );
    } else {
      type = this.#annotationType(statement.typeAnnotation);
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
      this.#recordRuntimeCheck(statement, type, `'${name}'`, value);
    }
    const variable: Variable = {
      name,
      type,
      shared: scope === this.#root && this.#effects.shared.has(name),
      declaration: statement.typeAnnotation === null ? statement : undefined,
      annotated: statement.typeAnnotation !== null,
    };
    if (statement.typeAnnotation === null) this.#declared.set(statement, variable);
    scope.declare(name, { kind: "variable", variable });
    this.#assigned(variable, value);
  }

  /** Directly after a store, a variable holds the stored value's type (rule 5.2). */
  #assigned(variable: Variable, value: StaticType): void {
    const narrowed = assignedType(variable.type, value);
    this.#flow.set(variable, resolved(narrowed) === resolved(variable.type) ? undefined : narrowed);
  }

  /** The type a variable is known to hold at the current point of the checked code. */
  #currentType(variable: Variable): StaticType {
    return this.#flow.get(variable) ?? variable.type;
  }

  /**
   * A wait, interaction, call, or other point where a handler or function may run: forget what is known about variables
   * that they may assign (rule 5.5).
   */
  #suspend(): void {
    this.#flow.forget(sharedVariable);
  }

  /** At the start of a loop: forget what its body (or a call or suspension in it) may change on an earlier iteration. */
  #widen(body: Block): void {
    const effects = this.#effects.loops.get(body) ?? { assigned: new Set(), suspends: true };
    this.#flow.forget(
      (variable) => effects.assigned.has(variable.name) || (effects.suspends && variable.shared),
    );
  }

  *#assignmentTask(statement: AssignmentStatement, scope: Scope): CompileTask<void> {
    const target = statement.target;
    let place: Place | undefined;
    let variable: Variable | undefined;
    let handle = false;
    /** For an element, the type it may hold now, which can be wider than what may be stored. */
    let read: StaticType | undefined;
    /** A speaker text property shows its value as text. */
    let shownField: string | null = null;
    /** A property without a static type, such as one of an `object` or of a value of unknown type. */
    let untyped = false;
    if (target.kind === "identifier") {
      const entry = scope.resolve(target.name);
      if (entry?.kind === "variable") {
        variable = entry.variable;
        place = variablePlace(variable);
      }
    } else {
      if (
        unwrap(target.object).kind !== "identifier" ||
        (target.kind === "indexExpression" && statement.operator !== "=")
      )
        this.#relaxNarrowedRoot(target.object, scope);
      const object = yield* compileChild(this.#expressionTask(target.object, scope));
      if (target.kind === "indexExpression") {
        const index = yield* compileChild(this.#expressionTask(target.index, scope));
        this.#checkIndex(object, target.object, index, target.index);
        if (statement.operator === "=") {
          const value = yield* compileChild(this.#expressionTask(statement.value, scope));
          const receiver = this.#elementReceiver(target.object, scope, object, value);
          yield* compileChild(
            this.#storeElementTask(receiver, target.object, statement.value, value, scope),
          );
          this.#recordRuntimeCheck(
            statement,
            elementStoreType(receiver) ?? UNKNOWN_TYPE,
            runtimePlace(target),
            value,
          );
          return;
        }
        // An element of a union of lists may be any member's, and what is stored must fit all of them.
        const store = elementStoreType(object);
        const lists = members(nonNullType(object));
        if (store !== undefined && lists.every(isList)) {
          const label = expressionLabel(target.object);
          const elements = elementPlace(
            { kind: "list", element: store },
            label,
            isNullable(object),
            this.#inferredCollection(target.object, scope),
            lists.length === 1 ? this.#pathOf(target.object, scope) : undefined,
          );
          place =
            lists.length === 1
              ? elements
              : {
                  ...elements,
                  subject: `${label === null ? "This list" : `'${label}'`} holds ${typeName(nonNullType(object)).replaceAll(" | ", " or ")}`,
                };
          read = elementType(object);
        }
      } else {
        const value = resolved(nonNullType(object));
        const name = target.property.name;
        // A new property takes its type from its first value, by the same rule as `let` (rule 1.4).
        if (value.kind === "object" && value.properties !== null && !value.properties.has(name)) {
          // A receiver that may be null needs a check first, also for a new property (owner decision on #504 Q1).
          const receivers = members(object);
          if (receivers.some((member) => member.kind === "null")) {
            this.#reportMayBe(
              target.object,
              NULL_TYPE,
              receivers.filter((member) => member.kind !== "null"),
            );
            yield* compileChild(this.#expressionTask(statement.value, scope));
            return;
          }
          const assigned = yield* compileChild(this.#expressionTask(statement.value, scope));
          this.#reportMixedChoice(statement.value, () => ONE_TYPE_FIX);
          if (statement.operator === "=") {
            value.properties.set(
              name,
              decidedSlot(this.#newPlaceType(statement.value, assigned), statement.value.span),
            );
            const owner = this.#pathOf(target.object, scope);
            if (owner !== undefined) {
              this.#follow(extendPath(owner, name), assigned, statement.value.span);
              this.#rewiden(owner.root);
            }
          }
          return;
        }
        const before = this.diagnostics.length;
        place = this.#propertyPlace(object, target.object, target.property, scope);
        const speakers = members(nonNullType(object)).map(
          (member) => resolved(member).kind === "speaker",
        );
        if (SPEAKER_TEXT_PROPERTIES.has(name) && speakers.includes(true))
          shownField = `the speaker's ${name}`;
        // A speaker shows its text property; any other receiver keeps the value as it is.
        untyped =
          place === undefined && this.diagnostics.length === before && speakers.includes(false);
        handle = mayBe(object, "timer", "media");
        // A media position, remaining time, or volume write first waits for the previous message's pacing.
        if (MEDIA_PACED_PROPERTIES.has(name) && mayBe(object, "media")) this.#suspend();
      }
    }
    const value = yield* compileChild(this.#expressionTask(statement.value, scope));
    if (shownField !== null) this.#checkShownText(statement.value, value, shownField);
    // A timer or media property write may run a block at once, such as an expiry at `remaining = 0 s`.
    if (handle) this.#suspend();
    if (place === undefined) {
      // No type is written for such a property either (#511 C2).
      if (untyped && statement.operator === "=")
        this.#reportMixedChoice(statement.value, () => ONE_TYPE_FIX);
      return;
    }
    // For `+=` and `-=`, the runtime checks the computed result, which is unknown when the operand is.
    this.#recordRuntimeCheck(statement, place.type, runtimePlace(target), value);
    if (statement.operator === "=") {
      yield* compileChild(this.#storeTask(place, statement.value, value));
      // A variable of unknown type may take the value's own type, so it gets a copy of a place it was read from.
      if (variable !== undefined) this.#assigned(variable, this.#capture(statement.value));
      return;
    }
    const operator = statement.operator === "+=" ? "+" : "-";
    const kept = resolved(
      read ?? (variable === undefined ? place.type : this.#currentType(variable)),
    );
    if (variable !== undefined) this.#flow.set(variable, undefined);
    // Adding or subtracting null is never supported.
    const outcome =
      resolved(nonNullType(value)).kind === "never"
        ? { failed: [kept, value] }
        : this.#memberOperation([kept, value], [target, statement.value], (a, b) =>
            arithmeticType(operator, a, b),
          );
    const result = "type" in outcome ? outcome.type : undefined;
    if (result !== undefined && !isKnown(result)) return;
    if (result === undefined) {
      const subject = place.subject;
      this.#report(
        typeCode.typeMismatch,
        `${subject}, so ${describeValue(value)} cannot be ${operator === "+" ? "added to" : "subtracted from"} ${place.verb === "contain" ? "an element" : "it"}.${operandFix(nonNullType(kept), statement.value)}`,
        statement.value.span,
      );
      return;
    }
    if (this.#widens(place, result, statement.value)) return;
    this.#follow(place.widening, result, statement.value.span);
    if (!isAssignable(place.type, result))
      this.#report(
        typeCode.typeMismatch,
        `${place.subject}, so '${statement.operator}' cannot make ${place.verb === "contain" ? "an element" : "it"} ${describeValue(result)}.${place.fix(result, null)}`,
        statement.value.span,
      );
    else if (variable !== undefined) this.#assigned(variable, result);
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
      kept.kind === "union" &&
      (literal.kind === "listLiteral" || literal.kind === "setLiteral")
    ) {
      // A collection literal in a union place is checked against the union's collection of its kind, or the first one
      // that takes every element (rule 3.4).
      const kind = literal.kind === "listLiteral" ? "list" : "set";
      const candidates = kept.members
        .map(resolved)
        .filter((member): member is Collection => member.kind === kind);
      let fitting = candidates.length === 1 ? candidates[0] : undefined;
      for (const candidate of candidates)
        if (fitting === undefined && (yield* compileChild(this.#fitsTask(candidate, literal))))
          fitting = candidate;
      if (fitting !== undefined) {
        yield* compileChild(
          this.#storeTask({ ...place, type: fitting }, expression, value, decides),
        );
        return;
      }
    }
    if (
      (kept.kind === "list" && literal.kind === "listLiteral") ||
      (kept.kind === "set" && literal.kind === "setLiteral")
    ) {
      // A declared element type decides what the literal may mix; `list` or `set` of any values does not, so a mixed
      // literal still needs a declared union.
      if (isKnown(kept.element)) this.#mixedLiterals.delete(literal);
      const elements = elementPlace(
        kept,
        place.label,
        isNullable(place.type),
        place.inferred !== undefined,
        place.widening,
      );
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
          added.push([property.name.name, this.#newPlaceType(property.value, type)]);
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
      if (decides && fits && added.length > 0 && place.widening !== undefined)
        this.#rewiden(place.widening.root);
      return;
    }
    if (isAssignable(place.type, value)) {
      // A place without a written type, or whose type the value would decide, cannot keep a mixed `choose`.
      if (place.inferred !== undefined || members(place.type).some((member) => !isKnown(member)))
        this.#reportMixedChoice(expression, (written) =>
          place.verb === "take" && place.label !== null
            ? `to keep both, declare the parameter as '${place.label}: ${written}'`
            : place.inferred === "variable" && place.label !== null
              ? `to keep both, declare it as 'let ${place.label}: ${written} = ...'`
              : ONE_TYPE_FIX,
        );
      if (decides) settle(place.type, value, expression.span);
      if (decides && place.widening !== undefined) this.#rewiden(place.widening.root);
      this.#follow(place.widening, value, expression.span);
      return;
    }
    if (this.#widens(place, value, expression)) return;
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
      `${place.subject}, so it cannot ${place.verb} ${describeValue(value)}.${this.#widenedNote(expression)}${checkFirstFix(place.type, value, expression) ?? place.fix(value, expression)}`,
      expression.span,
    );
  }

  /**
   * Whether storing a value widens an integer variable without a type annotation to a number (rule 1.2). The check then
   * starts again with the variable declared as a number, so this check reports nothing about the store.
   */
  #widens(place: Place, value: StaticType, expression: Expression): boolean {
    const owner = place.widening;
    if (owner === undefined) return false;
    // The value fits once the parts where it holds a number instead of an integer widen, and only then.
    const paths = numberPaths(place.type, value);
    if (paths.length === 0) return false;
    let widened = copyType(place.type);
    for (const path of paths) widened = widenPath(widened, path);
    if (!isAssignable(widened, value)) return false;
    let found = false;
    for (const path of paths) {
      const part = { root: owner.root, path: [...owner.path, ...path] };
      if (this.#widenedAt(part.root, part.path)) continue;
      this.#recordWidening(part, expression.span);
      found = true;
    }
    if (found) return true;
    // An element or property added after its variable was created takes what earlier checks widened; a place that
    // still does not fit is reported, not hidden.
    this.#rewiden(owner.root);
    const now = this.#typeAt(owner);
    return now !== undefined && isAssignable(now, value);
  }

  #recordWidening(place: PlacePath, at: SourceSpan): void {
    const paths = this.#widened.get(place.root) ?? new Map<string, SourceSpan>();
    paths.set(place.path.join("."), at);
    this.#widened.set(place.root, paths);
    this.widenedMore = true;
  }

  /** The assignment that widened a variable, element, or property, if an earlier check found one. */
  #widenedAt(root: Declaration, path: readonly string[]): SourceSpan | undefined {
    return this.#widened.get(root)?.get(path.join("."));
  }

  /** The origin that stands for an element or property inside a variable. */
  #partOrigin(root: Declaration, path: readonly string[]): PartOrigin {
    const key = path.join(".");
    const parts = this.#parts.get(root) ?? new Map<string, PartOrigin>();
    let part = parts.get(key);
    if (part === undefined) {
      part = { root, path: [...path] };
      parts.set(key, part);
      this.#parts.set(root, parts);
    }
    return part;
  }

  /**
   * A new variable's own type (rule 1.2): with what earlier checks widened in it, its own numbers deriving from the
   * variable, and those in its elements and properties also from the part they are.
   */
  #ownType(declaration: Declaration, type: StaticType): StaticType {
    const paths = this.#widened.get(declaration);
    let own = paths?.has("") === true ? widenedType(type) : type;
    for (const path of paths?.keys() ?? []) if (path !== "") own = widenPath(own, path.split("."));
    own = ownOrigins(own, declaration);
    ownPartOrigins(own, (path) => this.#partOrigin(declaration, path));
    return own;
  }

  /**
   * Widens again what earlier checks widened inside a variable, and gives new parts their origins, for elements and
   * properties that a store added after the variable was created.
   */
  #rewiden(root: Declaration): void {
    const variable = this.#declared.get(root);
    if (variable === undefined) return;
    for (const path of this.#widened.get(root)?.keys() ?? [])
      if (path !== "") widenPath(variable.type, path.split("."));
    ownPartOrigins(variable.type, (path) => this.#partOrigin(root, path));
  }

  /** The type a variable keeps at a path in it, or `undefined` when that part does not exist. */
  #typeAt(place: PlacePath): StaticType | undefined {
    let type: StaticType | undefined = this.#declared.get(place.root)?.type;
    for (const step of place.path) {
      if (type === undefined) return undefined;
      const value = resolved(nonNullType(type));
      if (step === "[]")
        type = value.kind === "list" || value.kind === "set" ? value.element : undefined;
      else type = value.kind === "object" ? (value.properties?.get(step) ?? undefined) : undefined;
    }
    return type;
  }

  /** Where the place an expression reads is inside a variable without a type annotation, if it is in one. */
  #pathOf(expression: Expression, scope: Scope): PlacePath | undefined {
    const steps: string[] = [];
    let node = unwrap(expression);
    for (;;) {
      if (node.kind === "indexExpression") steps.push("[]");
      else if (node.kind === "propertyAccessExpression") {
        const owner = members(nonNullType(this.#typeOf(node.object))).map(resolved);
        const element =
          LIST_ELEMENT_READS.has(node.property.name) &&
          owner.length === 1 &&
          (owner[0]!.kind === "list" || owner[0]!.kind === "set");
        steps.push(element ? "[]" : node.property.name);
      } else break;
      node = unwrap(node.object);
    }
    const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
    const root = entry?.kind === "variable" ? entry.variable.declaration : undefined;
    return root === undefined ? undefined : { root, path: steps.reverse() };
  }

  /**
   * Records that an integer variable, element, or property takes a value whose integers derive from other places (see
   * the `origins` of a scalar type), as its first value or by a later store, so it widens together with them. A
   * structured value carries each of its integers to the matching part.
   */
  #follow(target: PlacePath | undefined, value: StaticType, at: SourceSpan): void {
    if (target === undefined) return;
    for (const part of integerParts(value)) {
      const place: PlacePath = { root: target.root, path: [...target.path, ...part.path] };
      const key = place.path.join(".");
      for (const origin of part.origins) {
        const source = originPlace(origin);
        const sourceKey = source.path.join(".");
        if (source.root === place.root && sourceKey === key) continue;
        const paths = this.#followers.get(source.root) ?? new Map<string, Follower[]>();
        const followers = paths.get(sourceKey) ?? [];
        followers.push({ place, at });
        paths.set(sourceKey, followers);
        this.#followers.set(source.root, paths);
      }
    }
  }

  /** Why a value is a number when a non-whole number widened a variable it derives from, naming that assignment. */
  #widenedNote(expression: Expression | null): string {
    if (expression === null) return "";
    for (const origin of originsOf(this.#typeOf(expression))) {
      if ("root" in origin) continue;
      const at = this.#widenedAt(origin, []);
      if (at !== undefined)
        return ` '${declarationName(origin)}' is a number because line ${at.start.line + 1} can store a non-whole number in it.`;
    }
    return "";
  }

  /**
   * Whether every part of a value fits a type, looking into nested list and set literals, whose own types are not
   * decided until a place gives them one. It reports nothing and changes no type.
   */
  *#fitsTask(type: StaticType, expression: Expression): CompileTask<boolean> {
    const literal = unwrap(expression);
    if (literal.kind !== "listLiteral" && literal.kind !== "setLiteral")
      return isAssignable(type, this.#typeOf(expression));
    const kind = literal.kind === "listLiteral" ? "list" : "set";
    for (const member of members(nonNullType(type))) {
      if (member.kind === "unknown" || member.kind === "open") return true;
      if (member.kind !== kind) continue;
      let fits = true;
      for (const element of literal.elements)
        if (!(yield* compileChild(this.#fitsTask(member.element, element)))) {
          fits = false;
          break;
        }
      if (fits) return true;
    }
    return false;
  }

  /**
   * Stores a value as an element of a list or set, or of a union of them such as `integer[] | string[]`. The compiler
   * does not know which member holds the value, so it must fit every member; otherwise the author needs a test first.
   */
  *#storeElementTask(
    collection: StaticType,
    collectionExpression: Expression,
    expression: Expression,
    value: StaticType,
    scope: Scope,
  ): CompileTask<void> {
    const collections = members(nonNullType(collection)).map(resolved);
    const label = expressionLabel(collectionExpression);
    // A suggested declaration keeps the `?` of the declared variable, even where a test excluded null.
    const node = unwrap(collectionExpression);
    const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
    const nullable = isNullable(entry?.kind === "variable" ? entry.variable.type : collection);
    const inferred = this.#inferredCollection(collectionExpression, scope);
    const owner = collections.length === 1 ? this.#pathOf(collectionExpression, scope) : undefined;
    const places = collections.flatMap((member) =>
      member.kind === "list" || member.kind === "set"
        ? [elementPlace(member, label, nullable, inferred, owner)]
        : [],
    );
    if (places.length === 1 || places.length < collections.length) {
      // A value of unknown type has no written element type either (#511 C2).
      if (places.length === 0) this.#reportMixedChoice(expression, () => ONE_TYPE_FIX);
      for (const place of places.slice(0, 1))
        yield* compileChild(this.#storeTask(place, expression, value));
      return;
    }
    // A value of unknown type is checked at runtime against what every member's elements share. When they share
    // nothing, no value fits every member, so the author must test which member it is first.
    const shared = elementStoreType(collection);
    if (
      shared !== undefined &&
      resolved(shared).kind === "never" &&
      containsType(value, (part) => part.kind === "unknown")
    ) {
      this.#reportMayBe(collectionExpression, collections[1]!, [collections[0]!]);
      return;
    }
    const passing = collections.filter((_, index) => isAssignable(places[index]!.type, value));
    if (passing.length === collections.length) {
      for (const place of places) yield* compileChild(this.#storeTask(place, expression, value));
      return;
    }
    if (passing.length > 0) {
      const failing = collections.find((member) => !passing.includes(member))!;
      this.#reportMayBe(collectionExpression, failing, passing);
      return;
    }
    yield* compileChild(this.#storeTask(places[0]!, expression, value));
  }

  /**
   * Whether no type is written for the elements of a collection: one that a variable or parameter without an
   * annotation holds, possibly through elements, also where a test narrowed it, one held in a property, or a computed
   * one.
   */
  #inferredCollection(expression: Expression, scope: Scope): boolean {
    let node = unwrap(expression);
    let property = false;
    while (node.kind === "propertyAccessExpression" || node.kind === "indexExpression") {
      if (node.kind === "propertyAccessExpression" && !LIST_ELEMENT_READS.has(node.property.name))
        property = true;
      node = unwrap(node.object);
    }
    const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
    return property || entry?.kind !== "variable" || entry.variable.annotated !== true;
  }

  /**
   * The collection type an element store checks. A narrowed variable keeps its narrowed type for an element that
   * certainly fits it; any other element relaxes the narrowing (see {@link #relaxNarrowing}) and is checked against the
   * variable's type then, such as its declared `number[]` or `list`.
   */
  #elementReceiver(
    expression: Expression,
    scope: Scope,
    current: StaticType,
    element: StaticType,
  ): StaticType {
    const node = unwrap(expression);
    const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
    if (entry?.kind !== "variable") return current;
    // A call while the store was evaluated may have ended the narrowing: the variable's own members that the evaluated
    // receiver may be check it then, which keeps what was known, such as that it is not null.
    if (this.#flow.get(entry.variable) === undefined) {
      const kept = ownMembers(entry.variable, current);
      return kept.length === 0 ? current : union(kept);
    }
    // The fact stays only when the stored value certainly keeps it; a value of unknown type may not. A first store
    // into a collection whose element type is still undecided decides it, which a test never does.
    if (
      coversType(elementStoreType(current) ?? UNKNOWN_TYPE, element) &&
      !hasUndecidedElements(entry.variable.type)
    )
      return current;
    this.#relaxNarrowing(entry.variable);
    return this.#currentType(entry.variable);
  }

  /**
   * Keeps of what is known about a narrowed variable only which of its declared members it may hold, such as that it is
   * not null, and forgets what a store may change, such as the type of its elements.
   */
  #relaxNarrowing(variable: Variable): void {
    const fact = this.#flow.get(variable);
    if (fact === undefined) return;
    const kept = ownMembers(variable, fact);
    this.#flow.set(
      variable,
      kept.length === members(variable.type).length ? undefined : union(kept),
    );
  }

  /**
   * Before a store into a part of a narrowed variable that its narrowed type cannot follow, such as an element of an
   * element or a compound assignment to an element, the narrowing of the variable is relaxed.
   */
  #relaxNarrowedRoot(expression: Expression, scope: Scope): void {
    let node = unwrap(expression);
    while (node.kind === "propertyAccessExpression" || node.kind === "indexExpression")
      node = unwrap(node.object);
    const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
    if (entry?.kind === "variable") this.#relaxNarrowing(entry.variable);
  }

  /**
   * The place of a known property, or of a timer or media handle property, which must exist and be assignable. On a
   * union, every member must have the property; a value must then fit what all their property types share.
   */
  #propertyPlace(
    object: StaticType,
    objectExpression: Expression,
    property: Identifier,
    scope: Scope,
  ): Place | undefined {
    const name = property.name;
    const label = `${expressionLabel(objectExpression) ?? "this object"}.${name}`;
    const all = members(object).map(resolved);
    const targets = all.map((member) => assignableProperty(member, name));
    let type: StaticType | undefined;
    for (const [index, target] of targets.entries()) {
      if ("problem" in target) {
        const passing = all.filter((_, other) => !("problem" in targets[other]!));
        if (passing.length > 0) this.#reportMayBe(objectExpression, all[index]!, passing);
        else
          this.#report(
            typeCode.invalidOperand,
            target.problem,
            target.receiver === true ? objectExpression.span : property.span,
          );
        return undefined;
      }
      if (target.type !== null)
        type = type === undefined ? target.type : narrowTo(type, target.type);
    }
    if (type === undefined) return undefined;
    const owner =
      all.length === 1 && all[0]!.kind === "object"
        ? this.#pathOf(objectExpression, scope)
        : undefined;
    return propertyPlace(type, label, `'${label}'`, extendPath(owner, name));
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
      this.#recordRuntimeCheck(statement, declared, `the result of '${name}'`, value);
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
    this.#reportMixedChoice(
      statement.value,
      (written) =>
        `to keep both, declare the result type, as in 'function ${context.fn.declaration.name.name}(...): ${written}'`,
    );
    // The result is joined once the body is complete; a later statement may still change the place a value was read from.
    context.returns.push({ type: this.#capture(statement.value), span: statement.value.span });
  }

  /**
   * The type an annotation means. A set holds only text, numbers, true or false, date and time values, and null
   * (ADR 0014, V30 §35).
   */
  #annotationType(annotation: TypeAnnotation): StaticType {
    const pending: TypeAnnotation[] = [annotation];
    while (pending.length > 0) {
      const part = pending.pop()!;
      switch (part.kind) {
        case "namedType":
          break;
        case "listType":
          pending.push(part.element);
          break;
        case "setType": {
          pending.push(part.element);
          const element = typeFromAnnotation(part.element);
          if (!members(element).every(isSetElement))
            this.#report(
              typeCode.invalidSetElement,
              `A set holds only text, numbers, true or false, date and time values, or null, so it cannot hold ${typeName(element)} values. Use a list instead, as in '${typeName({ kind: "list", element })}'.`,
              part.span,
            );
          break;
        }
        case "optionalType":
          pending.push(part.value);
          break;
        case "unionType":
          for (const member of part.members) pending.push(member);
          break;
      }
    }
    return typeFromAnnotation(annotation);
  }

  // Functions --------------------------------------------------------------------------------------------------------

  /** Whether a function's parameters or body name a script variable that is not declared yet. */
  #usesLaterVariable(fn: FunctionType): boolean {
    let names = this.#namesUsed.get(fn);
    if (names === undefined) {
      names = namesIn(fn.declaration);
      this.#namesUsed.set(fn, names);
    }
    for (const name of names)
      if (this.#scriptVariables.has(name) && this.#root.resolve(name) === undefined) return true;
    return false;
  }

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
        : this.#annotationType(declaration.returnTypeAnnotation);
    if (fn.checking) return declared ?? UNKNOWN_TYPE;
    // A body that uses a script variable declared after this call waits until that variable has its type, so its stores
    // are checked against it; meanwhile a call sees the declared result, or an unknown one, as a recursive call does.
    if (!this.#scriptChecked && this.#usesLaterVariable(fn)) return declared ?? UNKNOWN_TYPE;
    fn.checking = true;
    // A call in the middle of a statement checks the function; the statement's own literals are reported after it.
    const outerLiterals = this.#mixedLiterals;
    this.#mixedLiterals = new Map();
    const parameters = yield* compileChild(this.#parametersTask(fn));
    const scope = new Scope(this.#root);
    // The body works on its own copies, so checking an argument never changes what the body assumes.
    const accepted: Variable[] = parameters.map((parameter) => ({
      ...parameter,
      type: copyType(parameter.type),
      shared: false,
    }));
    fn.accepted = accepted;
    for (const parameter of accepted) {
      if (parameter.declaration !== undefined) this.#declared.set(parameter.declaration, parameter);
      scope.declare(parameter.name, { kind: "variable", variable: parameter });
    }
    const context: FunctionContext = { fn, declared, returns: [], returnsNull: false };
    const outer = this.#function;
    const outerLoops = this.#loops.splice(0);
    const outerReachable = this.#reachable;
    const outerFlow = this.#flow;
    this.#function = context;
    this.#reachable = true;
    // A function body does not inherit narrowed facts from its caller (rule 5.5).
    this.#flow = new Flow();
    const continues = yield* compileChild(this.#statementsTask(declaration.body.statements, scope));
    this.#function = outer;
    this.#reachable = outerReachable;
    this.#flow = outerFlow;
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
          `'${context.fn.declaration.name.name}' returns ${describeValue(returned.type)} here, but ${describeValue(first.type)} on line ${first.span.start.line + 1}.${returnUnionFix(context.fn.declaration, first.type, returned.type)}`,
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
    const outerFlow = this.#flow;
    this.#flow = new Flow();
    for (const parameter of fn.declaration.parameters) {
      const name = parameter.name.name;
      let type: StaticType = UNKNOWN_TYPE;
      if (parameter.typeAnnotation !== null) type = this.#annotationType(parameter.typeAnnotation);
      if (parameter.defaultValue !== null) {
        const value = yield* compileChild(this.#expressionTask(parameter.defaultValue, scope));
        // Assignments in the body may widen an integer default, but calls never do (rule 1.5).
        if (parameter.typeAnnotation === null) {
          type = decidedType(placeType(value));
          this.#follow({ root: parameter, path: [] }, value, parameter.defaultValue.span);
          type = this.#ownType(parameter, type);
        } else {
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
          this.#recordRuntimeCheck(
            parameter,
            declared,
            `parameter '${name}' of '${fn.declaration.name.name}'`,
            value,
          );
        }
      }
      const declaration =
        parameter.typeAnnotation === null && parameter.defaultValue !== null
          ? parameter
          : undefined;
      const variable: Variable = {
        name,
        type,
        shared: false,
        declaration,
        annotated: parameter.typeAnnotation !== null,
      };
      if (declaration !== undefined) this.#declared.set(declaration, variable);
      parameters.push(variable);
      scope.declare(name, { kind: "variable", variable });
    }
    this.#reportMixedLiterals();
    this.#flow = outerFlow;
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
      yield* compileChild(this.#expressionTask(argument.value, scope));
      // An argument is the value as it was evaluated: a later argument or the body may still add a property to an
      // object it was read from.
      values.push(this.#capture(argument.value));
    }
    // The body is checked before the arguments, so they must fit the parameters as the body uses them.
    const result = copyType(yield* compileChild(this.#functionResultTask(fn)));
    if (fn.result === null)
      fn.pending.push({ call: expression, values, literals: this.#takeMixedLiterals(expression) });
    else yield* compileChild(this.#argumentsTask(fn, expression, values));
    // The function may assign shared variables or wait, so their narrowing ends here (rule 5.5).
    this.#suspend();
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
        inferred: declaration.typeAnnotation === null ? "variable" : undefined,
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
      this.#recordRuntimeCheck(
        argument,
        parameter.type,
        `parameter '${parameter.name}' of '${name}'`,
        values[argumentIndex]!,
      );
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
   * and its type is kept for the stores that later check its parts. The type of a place read is the place's own type:
   * use it at once, or keep it through {@link #capture}.
   */
  *#expressionTask(expression: Expression, scope: Scope): CompileTask<StaticType> {
    const result = yield* compileChild(this.#expressionTypeTask(expression, scope));
    const type = result.kind === "placeRead" ? result.type : result;
    if (result.kind === "placeRead") this.#placeReads.add(expression);
    this.#types.set(expression, type);
    return type;
  }

  /** The type of an expression that {@link #expressionTask} already checked. */
  #typeOf(expression: Expression): StaticType {
    return this.#types.get(expression) ?? UNKNOWN_TYPE;
  }

  /**
   * The type of a value that is kept beyond its expression, such as an argument, a part of a literal, or a returned
   * value, taken right after the expression was checked. A place read is copied as it is now (ADR 0014 copies values),
   * so later stores to the place do not change it, and later checks of the expression see the copy.
   */
  #capture(expression: Expression): StaticType {
    const type = this.#typeOf(expression);
    if (!this.#placeReads.delete(expression)) return type;
    const copy = copyType(type);
    this.#types.set(expression, copy);
    return copy;
  }

  /** The type a new place keeps for the value of a checked expression (rules 1.2–1.4), copied from a place read. */
  #newPlaceType(expression: Expression, type: StaticType): StaticType {
    return this.#placeReads.has(expression) ? placeType(type) : freshPlaceType(type);
  }

  *#expressionTypeTask(expression: Expression, scope: Scope): CompileTask<StaticType | PlaceRead> {
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
      case "parenthesizedExpression": {
        const type = yield* compileChild(this.#expressionTask(expression.expression, scope));
        return this.#placeReads.has(expression.expression) ? placeRead(type) : type;
      }
      case "identifier": {
        const entry = scope.resolve(expression.name);
        if (entry?.kind === "variable") return placeRead(this.#currentType(entry.variable));
        if (entry?.kind === "speaker" || (entry === undefined && expression.name === "speaker"))
          return { kind: "speaker" };
        return UNKNOWN_TYPE;
      }
      case "listLiteral":
      case "setLiteral": {
        // The literal owns its element types: each is the element as it was evaluated (ADR 0014 copies values).
        const types: StaticType[] = [];
        for (const item of expression.elements) {
          yield* compileChild(this.#expressionTask(item, scope));
          types.push(this.#capture(item));
          if (expression.kind === "setLiteral") this.#checkSetElement(item, this.#typeOf(item));
        }
        // Elements of known types must share one type; an element of unknown type leaves the element type unknown. A
        // `choose` that returns values of different types mixes them too.
        const known = types.filter((type) => resolved(type).kind !== "unknown");
        const choice = expression.elements.find((item) => this.#mixedChoices.has(unwrap(item)));
        let element = types.length === 0 ? openType() : joinTypes(known);
        if (choice !== undefined) {
          this.#mixedLiterals.set(expression, members(this.#mixedChoices.get(unwrap(choice))!));
          element = undefined;
        }
        if (element === undefined && choice === undefined)
          this.#mixedLiterals.set(expression, known);
        if (element === undefined || known.length < types.length) element = UNKNOWN_TYPE;
        return { kind: expression.kind === "listLiteral" ? "list" : "set", element };
      }
      case "objectLiteral": {
        const properties = new Map<string, StaticType>();
        for (const property of expression.properties) {
          yield* compileChild(this.#expressionTask(property.value, scope));
          const value = this.#capture(property.value);
          // A property is a place without a declared type, so it cannot keep a mixed `choose` (#511 C2).
          this.#reportMixedChoice(property.value, () => ONE_TYPE_FIX);
          properties.set(property.name.name, freshPlaceType(value));
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
        const element = elementType(object);
        return element === undefined ? UNKNOWN_TYPE : placeRead(element);
      }
      case "callExpression":
        return yield* compileChild(this.#callTask(expression, scope));
      case "unaryExpression": {
        if (expression.operator === "not")
          return yield* compileChild(this.#valueOfConditionTask(expression, scope));
        const operand = yield* compileChild(this.#expressionTask(expression.operand, scope));
        return this.#operation(expression.operator, [operand], expression, (value) =>
          isNumeric(value) || isScalar(value, "duration")
            ? negatedValues(resolved(value), expression.operator)
            : undefined,
        );
      }
      case "binaryExpression":
        return yield* compileChild(this.#binaryTask(expression, scope));
      case "rangeExpression": {
        for (const bound of [expression.start, expression.end]) {
          const type = yield* compileChild(this.#expressionTask(bound, scope));
          this.#reportUnless(type, isNumeric, bound, "A range bound is a number");
        }
        return { kind: "range" };
      }
      case "interactionExpression": {
        const type = yield* compileChild(this.#interactionTask(expression, scope));
        this.#suspend();
        return type;
      }
      case "showButtonExpression":
        yield* compileChild(this.#showButtonTask(expression, scope));
        this.#suspend();
        return DURATION_TYPE;
      case "timerExpression":
        yield* compileChild(this.#timerTask(expression, scope));
        this.#suspend();
        return expression.async ? { kind: "timer" } : UNKNOWN_TYPE;
      case "playMediaExpression":
        return yield* compileChild(this.#mediaTask(expression, scope, null));
      case "loadExpression": {
        yield* compileChild(this.#storageKeyTask(expression.key, scope));
        if (expression.defaultValue === null) return UNKNOWN_TYPE;
        // The default runs only for a missing key, so what it changes may or may not have happened afterwards.
        const start = this.#flow.mark();
        yield* compileChild(this.#expressionTask(expression.defaultValue, scope));
        const changes = this.#flow.undo(start);
        this.#flow.apply(this.#flow.join([new Map(), changes]));
        return UNKNOWN_TYPE;
      }
      case "typeTestExpression":
        return yield* compileChild(this.#valueOfConditionTask(expression, scope));
    }
  }

  /** The value of a test or logical expression used as a value: the flows of both outcomes join afterwards. */
  *#valueOfConditionTask(expression: Expression, scope: Scope): CompileTask<StaticType> {
    const branches = yield* compileChild(this.#branchTask(expression, scope));
    this.#flow.apply(this.#flow.join([branches.whenTrue, branches.whenFalse]));
    return branches.type;
  }

  /**
   * Checks an expression whose truth narrows variables (rule 5.1): a type test, `== null` or `!= null`, `not`, `and`,
   * `or`, or a boolean literal, and returns the flows when it is true and when it is false.
   */
  *#branchTask(expression: Expression, scope: Scope): CompileTask<Branches> {
    // Both outcomes are what the condition changed, including what evaluating it changed, from the flow before it.
    const start = this.#flow.mark();
    const branches = yield* compileChild(this.#branchKindTask(expression, scope, start));
    this.#flow.undo(start);
    this.#types.set(expression, branches.type);
    return branches;
  }

  *#branchKindTask(expression: Expression, scope: Scope, start: FlowState): CompileTask<Branches> {
    const node = unwrap(expression);
    switch (node.kind) {
      case "booleanLiteral": {
        const changes = this.#flow.since(start);
        return node.value
          ? { type: BOOLEAN_TYPE, whenTrue: changes, whenFalse: null }
          : { type: BOOLEAN_TYPE, whenTrue: null, whenFalse: changes };
      }
      case "unaryExpression": {
        if (node.operator !== "not") break;
        const operand = yield* compileChild(this.#branchTask(node.operand, scope));
        this.#requireBoolean(operand.type, node.operand, "'not' needs true or false (boolean)");
        return { type: BOOLEAN_TYPE, whenTrue: operand.whenFalse, whenFalse: operand.whenTrue };
      }
      case "binaryExpression": {
        if (node.operator === "and" || node.operator === "or") {
          const rule = `'${node.operator}' needs true or false (boolean) values`;
          const left = yield* compileChild(this.#branchTask(node.left, scope));
          this.#requireBoolean(left.type, node.left, rule);
          // The right operand runs only when the left one did not decide the result.
          const runsRight = node.operator === "and" ? left.whenTrue : left.whenFalse;
          this.#flow.apply(runsRight);
          const right = yield* compileChild(this.#branchTask(node.right, scope));
          this.#requireBoolean(right.type, node.right, rule);
          const reached = runsRight !== null;
          const rightTrue =
            reached && right.whenTrue !== null ? this.#flow.since(start, right.whenTrue) : null;
          const rightFalse =
            reached && right.whenFalse !== null ? this.#flow.since(start, right.whenFalse) : null;
          this.#flow.undo(start);
          return node.operator === "and"
            ? {
                type: BOOLEAN_TYPE,
                whenTrue: rightTrue,
                whenFalse: this.#flow.join([left.whenFalse, rightFalse]),
              }
            : {
                type: BOOLEAN_TYPE,
                whenTrue: this.#flow.join([left.whenTrue, rightTrue]),
                whenFalse: rightFalse,
              };
        }
        if (node.operator !== "==" && node.operator !== "!=") break;
        const nullTest =
          unwrap(node.right).kind === "nullLiteral"
            ? node.left
            : unwrap(node.left).kind === "nullLiteral"
              ? node.right
              : null;
        if (nullTest === null) break;
        const left = yield* compileChild(this.#expressionTask(node.left, scope));
        const right = yield* compileChild(this.#expressionTask(node.right, scope));
        this.#warnImpossibleComparison(node, left, right);
        const tested = this.#narrowTest(nullTest, scope, NULL_TYPE, start);
        return node.operator === "=="
          ? tested
          : { type: BOOLEAN_TYPE, whenTrue: tested.whenFalse, whenFalse: tested.whenTrue };
      }
      case "typeTestExpression": {
        const value = yield* compileChild(this.#expressionTask(node.value, scope));
        const test = this.#annotationType(node.type);
        this.#warnConstantTest(node, value, test);
        const tested = this.#narrowTest(node.value, scope, test, start);
        return node.negated
          ? { type: BOOLEAN_TYPE, whenTrue: tested.whenFalse, whenFalse: tested.whenTrue }
          : tested;
      }
      default:
        break;
    }
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    const changes = this.#flow.since(start);
    return { type, whenTrue: changes, whenFalse: changes };
  }

  /** The outcomes of `value is test`: only a plain variable narrows, not a property or element (rule 5.4). */
  #narrowTest(value: Expression, scope: Scope, test: StaticType, start: FlowState): Branches {
    const node = unwrap(value);
    const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
    if (entry?.kind !== "variable") {
      const changes = this.#flow.since(start);
      return { type: BOOLEAN_TYPE, whenTrue: changes, whenFalse: changes };
    }
    const current = this.#currentType(entry.variable);
    const passed = narrowTo(current, test);
    const failed = excludeType(current, test);
    // An outcome that no value of the variable can produce is not reached, such as the end of exhaustive tests.
    return {
      type: BOOLEAN_TYPE,
      whenTrue:
        passed.kind === "never"
          ? null
          : this.#flow.since(start, new Map([[entry.variable, passed]])),
      whenFalse:
        failed.kind === "never"
          ? null
          : this.#flow.since(start, new Map([[entry.variable, failed]])),
    };
  }

  /**
   * Warns about `==` or `!=` with a value that one side can never hold, such as a `choose` result compared with a value
   * no button returns (#511 C5); {@link #neverMatchingCaseValue} applies it to a literal `case` value.
   */
  #warnImpossibleComparison(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
    left: StaticType,
    right: StaticType,
  ): void {
    for (const [side, type, other, otherType] of [
      [expression.left, left, expression.right, right],
      [expression.right, right, expression.left, left],
    ] as const) {
      const possible = possibleValues(type);
      if (possible === undefined) continue;
      const otherValues = possibleValues(otherType) ?? comparedLiteral(other);
      if (otherValues === undefined || otherValues.some((value) => mayEqual(type, value))) continue;
      const label = expressionLabel(side);
      this.diagnostics.push(
        createDiagnostic(
          DiagnosticSeverity.Warning,
          typeCode.constantTest,
          `${label === null ? "This value" : `'${label}'`} is always ${describeLiterals(possible)} here, so this comparison is always ${expression.operator === "==" ? "false" : "true"}.`,
          expression.span,
        ),
      );
      return;
    }
  }

  /**
   * Why a literal `case` value never matches what the switched value can still hold, or `undefined` when it may: the
   * cases above took every value of its type, as `case is integer` before `case 5`, or a `choose` result never is it
   * (#511 C5). The case compares with `==` (V30 §32).
   */
  #neverMatchingCaseValue(
    subjectExpression: Expression,
    subject: StaticType,
    value: Expression,
    valueType: StaticType,
  ): string | undefined {
    const label = expressionLabel(subjectExpression);
    const holder = label === null ? "This value" : `'${label}'`;
    if (subject.kind === "never")
      return "The cases above take every value, so this case never matches.";
    // The cases above may have taken every value of this case's type, as `case is integer` before `case 5`.
    if (
      isKnown(subject) &&
      !containsType(subject, (part) => part.kind === "open") &&
      impossibleCaseMessage(subjectExpression, subject, value, valueType) !== undefined
    )
      return `${holder} holds ${describeValue(subject)} here, after the cases above, so this case never matches.`;
    const possible = possibleValues(subject);
    const literal = comparedLiteral(value);
    if (
      possible === undefined ||
      literal === undefined ||
      literal.some((one) => mayEqual(subject, one))
    )
      return undefined;
    return `${holder} is always ${describeLiterals(possible)} here, so this case never matches.`;
  }

  /** Warns about `case is T` or `case is not T` that no value left by the cases above can pass, like a constant test. */
  #warnNeverMatchingTypeCase(
    subjectExpression: Expression,
    remaining: StaticType,
    typeTest: SwitchTypeTest,
    test: StaticType,
    taken: StaticType,
  ): void {
    if (taken.kind !== "never") return;
    if (
      remaining.kind !== "never" &&
      (!isKnown(remaining) || containsType(remaining, (part) => part.kind === "open"))
    )
      return;
    const label = expressionLabel(subjectExpression);
    const holder = label === null ? "This value" : `'${label}'`;
    const possible = remaining.kind === "never" ? undefined : possibleValues(remaining);
    const holds =
      remaining.kind === "never"
        ? "The cases above take every value"
        : possible !== undefined
          ? `${holder} is always ${describeLiterals(possible)} here`
          : typeTest.negated
            ? `${holder} always holds ${describeValue(remaining)} here`
            : `${holder} holds ${describeValue(remaining)} here, never ${typeName(test)}`;
    this.diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Warning,
        typeCode.constantTest,
        `${holds}, so this case never matches.`,
        typeTest.span,
      ),
    );
  }

  /** Warns about a type test whose result the compiler can prove (ADR 0021 rule 4.5). */
  #warnConstantTest(
    node: Extract<Expression, { kind: "typeTestExpression" }>,
    value: StaticType,
    test: StaticType,
  ): void {
    if (!isKnown(value) || containsType(value, (part) => part.kind === "open")) return;
    const passes = narrowTo(value, test).kind !== "never";
    const fails = excludeType(value, test).kind !== "never";
    if (passes && fails) return;
    const label = expressionLabel(node.value);
    const subject = label === null ? "This value" : `'${label}'`;
    // Button values say why, as in `'n' is always 1 or 2 here` for a test of whole numbers.
    const possible = possibleValues(value);
    const holds =
      possible !== undefined
        ? `${subject} is always ${describeLiterals(possible)} here`
        : passes
          ? `${subject} always holds ${describeValue(value)}`
          : `${subject} holds ${describeValue(value)}, never ${typeName(test)}`;
    this.diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Warning,
        typeCode.constantTest,
        `${holds}, so this test is always ${passes !== node.negated ? "true" : "false"}.`,
        node.span,
      ),
    );
  }

  *#binaryTask(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
    scope: Scope,
  ): CompileTask<StaticType> {
    if (
      ["and", "or"].includes(expression.operator) ||
      (["==", "!="].includes(expression.operator) &&
        (unwrap(expression.left).kind === "nullLiteral" ||
          unwrap(expression.right).kind === "nullLiteral"))
    )
      return yield* compileChild(this.#valueOfConditionTask(expression, scope));
    const left = yield* compileChild(this.#expressionTask(expression.left, scope));
    const right = yield* compileChild(this.#expressionTask(expression.right, scope));
    switch (expression.operator) {
      case "==":
      case "!=":
        this.#warnImpossibleComparison(expression, left, right);
        return BOOLEAN_TYPE;
      case "<":
      case "<=":
      case ">":
      case ">=":
        this.#operation(expression.operator, [left, right], expression, (a, b) =>
          (isNumeric(a) && isNumeric(b)) ||
          (isScalar(a, "string") && isScalar(b, "string")) ||
          (isScalar(a, "duration") && isScalar(b, "duration")) ||
          // Date and time values order only within one kind (V30 §35).
          (isTemporal(a) && typeName(a) === typeName(b))
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
   * rule 3.5). A possibly null operand needs a check first (rule 1.9). An unknown operand gives an unknown result.
   */
  #operation(
    operator: string,
    operands: readonly StaticType[],
    expression: Extract<Expression, { kind: "unaryExpression" | "binaryExpression" }>,
    result: (...values: StaticType[]) => StaticType | undefined,
  ): StaticType {
    const outcome = this.#memberOperation(
      operands,
      expression.kind === "binaryExpression"
        ? [expression.left, expression.right]
        : [expression.operand],
      result,
    );
    if ("type" in outcome) return outcome.type;
    this.#report(
      typeCode.invalidOperand,
      operatorMessage(operator, expression, outcome.failed),
      expression.span,
    );
    return UNKNOWN_TYPE;
  }

  /**
   * Applies an operation to every combination of its operands' members. When some members of one operand work with
   * every member of the other, that operand needs a test first, which is reported here; when no combination works, the
   * failing members are returned for the caller's message.
   */
  #memberOperation(
    operands: readonly StaticType[],
    expressions: readonly Expression[],
    result: (...values: StaticType[]) => StaticType | undefined,
  ): { readonly type: StaticType } | { readonly failed: readonly StaticType[] } {
    const values = operands.map((operand) => resolved(operand));
    const lefts = members(values[0]!);
    const rights = values.length > 1 ? members(values[1]!) : [];
    const apply = (left: StaticType, right: StaticType | undefined): StaticType | undefined =>
      right === undefined ? result(left) : result(left, right);
    // A known member that no value could combine with, such as text in `+`, fails whatever the unknown other operand
    // is, so it is reported as it is, not as a missing null check.
    const possible = (member: StaticType, index: number): boolean =>
      values.length === 1
        ? apply(member, undefined) !== undefined
        : OPERAND_KINDS.some(
            (other) => (index === 0 ? apply(member, other) : apply(other, member)) !== undefined,
          );
    for (const [index, all] of [lefts, rights].entries()) {
      const others = index === 0 ? rights : lefts;
      if (values.length === 1 && index === 1) continue;
      if (others.some((member) => member.kind !== "null" && isKnown(member))) continue;
      const impossible = all.find(
        (member) => member.kind !== "null" && isKnown(member) && !possible(member, index),
      );
      if (impossible === undefined) continue;
      // The members that work besides it are what a test keeps (ADR 0021 rule 3.5).
      const passing = all.filter(
        (member) => member.kind !== "null" && isKnown(member) && possible(member, index),
      );
      if (passing.length > 0) {
        this.#reportMayBe(expressions[index]!, impossible, passing);
        return { type: UNKNOWN_TYPE };
      }
      return { failed: index === 0 ? [impossible, UNKNOWN_TYPE] : [UNKNOWN_TYPE, impossible] };
    }
    // An operand that may be null needs a check first (owner decision on #504 Q1), whatever the other operand is.
    const named = new Set<string>();
    for (const [index, all] of [lefts, rights].entries()) {
      const others = (index === 0 ? rights : lefts).map((member) =>
        isKnown(member) ? member : UNKNOWN_TYPE,
      );
      const takesNull = (others.length > 0 ? others : [undefined]).some(
        (other) =>
          (index === 0 ? apply(NULL_TYPE, other) : apply(other ?? NULL_TYPE, NULL_TYPE)) !==
          undefined,
      );
      const passing = all.filter((member) => member.kind !== "null");
      if (!all.some((member) => member.kind === "null") || passing.length === 0 || takesNull)
        continue;
      // Only when null is the one problem: every other member works with the other operand, as far as it is known.
      const otherValues = others.filter((other) => other.kind !== "null" && isKnown(other));
      const works =
        (others.length > 0 && otherValues.length === 0) ||
        passing.every((member) =>
          (otherValues.length > 0 ? otherValues : [undefined]).every(
            (other) =>
              (index === 0 ? apply(member, other) : apply(other ?? member, member)) !== undefined,
          ),
        );
      if (!works) continue;
      const label = expressionLabel(expressions[index]!) ?? `operand ${index}`;
      if (!named.has(label)) this.#reportMayBe(expressions[index]!, NULL_TYPE, passing);
      named.add(label);
    }
    if (named.size > 0) return { type: UNKNOWN_TYPE };
    if (operands.some((operand) => !isKnown(nonNullTypeForUse(operand))))
      return { type: UNKNOWN_TYPE };
    const results: StaticType[] = [];
    let failed: readonly StaticType[] | undefined;
    for (const left of lefts) {
      for (const right of rights.length > 0 ? rights : [undefined]) {
        const type = apply(left, right);
        if (type === undefined) failed ??= right === undefined ? [left] : [left, right];
        else results.push(type);
      }
    }
    // Results of different types stay known as a union, so a later use of the result is checked too.
    if (failed === undefined) return { type: results.length === 1 ? results[0]! : union(results) };
    const working = [
      lefts.filter((left) =>
        (rights.length > 0 ? rights : [undefined]).every(
          (right) => apply(left, right) !== undefined,
        ),
      ),
      rights.filter((right) => lefts.every((left) => apply(left, right) !== undefined)),
    ];
    for (const [index, passing] of working.entries()) {
      const all = index === 0 ? lefts : rights;
      const failing = all.find((member) => !passing.includes(member));
      if (passing.length > 0 && failing !== undefined) {
        this.#reportMayBe(expressions[index]!, failing, passing);
        return { type: UNKNOWN_TYPE };
      }
    }
    return { failed };
  }

  *#callTask(expression: CallExpression, scope: Scope): CompileTask<StaticType> {
    let callee = expression.callee;
    while (callee.kind === "parenthesizedExpression") callee = callee.expression;
    if (callee.kind === "identifier") {
      const entry = scope.resolve(callee.name);
      if (entry?.kind === "function")
        return yield* compileChild(this.#functionCallTask(expression, entry.fn, scope));
      const values: StaticType[] = [];
      for (const argument of expression.arguments) {
        yield* compileChild(this.#expressionTask(argument.value, scope));
        // A built-in takes each argument as it was evaluated, before later arguments run.
        values.push(this.#capture(argument.value));
      }
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
    const method = callee.property.name;
    if (method === "add" && unwrap(callee.object).kind !== "identifier")
      this.#relaxNarrowedRoot(callee.object, scope);
    const receiver = yield* compileChild(this.#expressionTask(callee.object, scope));
    const value = resolved(receiver);
    // The receiver as it was evaluated, before the arguments run, for the checks of text operations and `join`. Only
    // they use it, so other methods, such as repeated `add` calls on a growing list, do not copy their receiver.
    const receiverAtCall =
      TEXT_MEMBERS.has(method) || method === "join" ? copyType(receiver) : receiver;
    const typeOf = (argument: Expression): StaticType => this.#typeOf(argument);
    const memberChecks = (): void =>
      this.#reportProblems(
        memberProblems(callee.object, receiverAtCall, callee.property, expression, typeOf),
      );
    // Pausing, resuming, or stopping media first waits for the previous message's pacing.
    if (["pause", "resume", "stop"].includes(method) && mayBe(receiver, "media")) this.#suspend();
    const collections = members(value).every((member) =>
      ["list", "set"].includes(resolved(member).kind),
    );
    if (collections && method === "add") {
      const argument = expression.arguments[0];
      if (argument !== undefined && expression.arguments.length === 1) {
        const type = yield* compileChild(this.#expressionTask(argument.value, scope));
        if (isSetReceiver(receiver) && !this.#checkSetElement(argument.value, type))
          return NULL_TYPE;
        const collection = this.#elementReceiver(callee.object, scope, receiver, type);
        yield* compileChild(
          this.#storeElementTask(collection, callee.object, argument.value, type, scope),
        );
        // For a union of collections, the runtime checks what every member's elements share.
        const kind = resolved(members(nonNullType(collection))[0]!).kind === "set" ? "set" : "list";
        this.#recordRuntimeCheck(
          expression,
          elementStoreType(collection) ?? UNKNOWN_TYPE,
          elementLabel(expressionLabel(callee.object), kind),
          type,
        );
        return NULL_TYPE;
      }
    }
    const values: StaticType[] = [];
    for (const argument of expression.arguments) {
      yield* compileChild(this.#expressionTask(argument.value, scope));
      values.push(this.#capture(argument.value));
    }
    if (!isKnown(value)) {
      // Only text and lists have these methods, so their arguments are checked on any receiver.
      memberChecks();
      // A value of unknown type has no written element type either (#511 C2).
      if (method === "add")
        for (const argument of expression.arguments)
          this.#reportMixedChoice(argument.value, () => ONE_TYPE_FIX);
      return UNKNOWN_TYPE;
    }
    if (method === "removeAt" && values.length === 1 && members(value).every(isList))
      this.#checkIndex(value, callee.object, values[0]!, expression.arguments[0]!.value);
    // A set compares only values it can hold, and a list becomes a set only of such values.
    if ((method === "contains" || method === "remove") && isSetReceiver(value))
      for (const [index, argument] of expression.arguments.entries())
        this.#checkSetElement(argument.value, values[index]!);
    if (method === "toSet")
      for (const member of members(nonNullType(value)).map(resolved))
        if (member.kind === "list" && !this.#checkSetElement(expression, member.element)) break;
    // Every member of a union must have the method (ADR 0021 rule 3.5).
    const all = members(value);
    const results = all.map((member) => memberMethodType(member, method));
    const passing = all.filter((_, index) => results[index] !== undefined);
    if (passing.length === all.length) {
      const handles = all.every((member) => ["timer", "media"].includes(resolved(member).kind));
      if (handles && expression.arguments.length > 0)
        this.#report(
          typeCode.invalidOperand,
          `${resolved(all[0]!).kind === "timer" ? "Timer" : "Media"} ${method}() takes no arguments.`,
          callee.property.span,
        );
      const textual = TEXT_MEMBERS.has(method) || method === "join";
      if (textual || COLLECTION_METHODS.has(method)) {
        // Each member takes the arguments as the one receiver would (ADR 0021 rule 3.5), and the results join. A problem
        // that several members share at one place is reported once.
        const before = this.diagnostics.length;
        const atCall = members(resolved(receiverAtCall));
        const memberResults = all.map((member, index) => {
          const kept = resolved(member);
          if (textual) {
            this.#reportProblems(
              memberProblems(
                callee.object,
                atCall[index] ?? member,
                callee.property,
                expression,
                typeOf,
              ),
            );
            return results[index]!;
          }
          return kept.kind === "list" || kept.kind === "set"
            ? this.#collectionMethodType(method, kept, callee.property, expression)
            : results[index]!;
        });
        this.#keepFirstDiagnostics(before);
        return memberResults.length === 1 ? memberResults[0]! : union(memberResults);
      }
      // The methods of date and time values take no arguments; a format follows the player's settings.
      if (all.every(isTemporal) && expression.arguments.length > 0)
        this.#report(
          typeCode.argumentCount,
          method.startsWith("format")
            ? `${method}() takes no arguments: it shows the value in the player's own date and time format.`
            : `${method}() takes no arguments.`,
          callee.property.span,
        );
      return all.length === 1 ? results[0]! : union(results.map((result) => result!));
    }
    const failing = resolved(all.find((_, index) => results[index] === undefined)!);
    if (passing.length > 0) this.#reportMayBe(callee.object, failing, passing);
    // Text operations and values without methods name what to write instead (V30 §8).
    else if (all.length === 1 && MEMBER_CHECKED_KINDS.has(failing.kind)) memberChecks();
    // A set has no order to sort or shuffle (V30 §16).
    else if (all.length === 1 && failing.kind === "set" && COLLECTION_METHODS.has(method))
      this.#reportProblems(
        collectionMethodProblems(method, failing, callee.property, expression, (argument) =>
          this.#typeOf(argument),
        ),
      );
    else
      this.#report(
        typeCode.invalidOperand,
        failing.kind === "list" || failing.kind === "set"
          ? `${failing.kind === "list" ? "Lists" : "Sets"} have no method '${method}'.`
          : failing.kind === "timer" || failing.kind === "media"
            ? handleMemberMessage(failing.kind, method, "call")
            : `${capitalize(describeValue(failing))} has no method '${method}'.`,
        callee.property.span,
      );
    return UNKNOWN_TYPE;
  }

  /**
   * Checks `sort`, `shuffle`, or a set operation on one list or set, as evaluated, and gives its result (V30 §16).
   */
  #collectionMethodType(
    method: string,
    value: StaticType & { readonly kind: "list" | "set" },
    property: Identifier,
    expression: CallExpression,
  ): StaticType {
    const typeOf = (argument: Expression): StaticType => this.#typeOf(argument);
    const problems = collectionMethodProblems(method, value, property, expression, typeOf);
    this.#reportProblems(problems);
    if (method === "sort" || method === "shuffle") return NULL_TYPE;
    // A set's union adds the argument's elements, which must be values a set can hold.
    const argument = expression.arguments[0]?.value;
    const lists =
      argument === undefined || method !== "union" || value.kind !== "set"
        ? []
        : members(nonNullTypeForUse(typeOf(argument)))
            .map(resolved)
            .filter((member) => member.kind === "list");
    let held = true;
    for (const list of lists)
      if (list.kind === "list" && !this.#checkSetElement(argument!, list.element)) {
        held = false;
        break;
      }
    return this.#setOperationType(method, value, expression, problems.length === 0 && held);
  }

  /**
   * The result of `intersection`, `union`, or `difference`: a new collection of the receiver's kind. `union` holds the
   * elements of both, so their types join as in a list literal; other operations keep the receiver's element type.
   */
  #setOperationType(
    method: string,
    receiver: StaticType & { readonly kind: "list" | "set" },
    expression: CallExpression,
    reportMix: boolean,
  ): StaticType {
    const own = copyType(receiver.element);
    const argumentExpression = expression.arguments[0]?.value;
    if (method !== "union" || argumentExpression === undefined)
      return { kind: receiver.kind, element: own };
    // A union argument adds the elements of whichever collection it is.
    const others: StaticType[] = [];
    for (const member of members(nonNullType(this.#typeOf(argumentExpression))).map(resolved)) {
      if (member.kind !== "list" && member.kind !== "set")
        return { kind: receiver.kind, element: UNKNOWN_TYPE };
      others.push(copyType(member.element));
    }
    const other = union(others);
    if (resolved(own).kind === "unknown" || resolved(other).kind === "unknown")
      return { kind: receiver.kind, element: UNKNOWN_TYPE };
    const element = joinTypes([own, ...others]);
    if (element === undefined) {
      if (reportMix)
        this.#report(
          typeCode.mixedTypes,
          `union() would mix ${mixDescription(own, other)}. A ${receiver.kind} holds one type; keep values of different types in separate ${receiver.kind}s.`,
          expression.span,
        );
      return { kind: receiver.kind, element: UNKNOWN_TYPE };
    }
    return { kind: receiver.kind, element };
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
            isNumeric,
            argument.value,
            "chance(...) takes a percentage number",
          );
        return BOOLEAN_TYPE;
      case "randomInteger":
        if (argument !== undefined && value !== undefined)
          this.#reportUnless(
            value,
            (member) => member.kind === "range",
            argument.value,
            "randomInteger(...) takes a range such as 1..=6",
          );
        return INTEGER_TYPE;
      case "round":
      case "floor":
      case "ceil":
        {
          const problems = builtinCallProblems(name, expression, (item) => this.#typeOf(item));
          // A union or a possibly null number names the test or the check first (ADR 0021 rule 3.5, #504 Q1).
          if (
            problems.every((problem) => problem.kind === "invalidOperand") &&
            argument !== undefined &&
            value !== undefined &&
            members(value).length > 1
          )
            this.#reportUnless(value, isNumeric, argument.value, `${name}(...) takes a number`);
          else this.#reportProblems(problems);
        }
        return INTEGER_TYPE;
      case "min":
      case "max": {
        const problems = builtinCallProblems(name, expression, (item) => this.#typeOf(item));
        // An argument that may be one of several types, or null, names the test or the check first (ADR 0021 rule 3.5,
        // #504 Q1): each of its members must be of the family the other arguments decide, numbers or durations.
        const several = problems.every((problem) => problem.kind === "invalidOperand")
          ? expression.arguments.filter((item) => members(this.#typeOf(item.value)).length > 1)
          : [];
        const familyOf = (member: StaticType): string | undefined =>
          isNumeric(member) ? "numbers" : isScalar(member, "duration") ? "durations" : undefined;
        const families = expression.arguments.map((item) => [
          ...new Set(members(nonNullType(this.#typeOf(item.value))).map(familyOf)),
        ]);
        const family =
          families.find((one) => one.length === 1 && one[0] !== undefined)?.[0] ??
          families[0]?.find((one) => one !== undefined);
        const spans = new Set(several.map((item) => item.value.span.start.offset));
        this.#reportProblems(problems.filter((problem) => !spans.has(problem.span.start.offset)));
        for (const item of several)
          this.#reportUnless(
            this.#typeOf(item.value),
            (member) => familyOf(member) !== undefined && familyOf(member) === family,
            item.value,
            `${name}(...) needs all numbers or all durations`,
          );
        // The result is an integer when every argument is one, like arithmetic on them (ADR 0021 rule 2.2).
        const numbers = values.map(nonNullTypeForUse);
        if (numbers.length < 2) return UNKNOWN_TYPE;
        if (numbers.every((number) => isScalar(number, "duration"))) return DURATION_TYPE;
        let result: StaticType | undefined = numbers[0];
        for (const number of numbers.slice(1))
          result = result === undefined ? undefined : arithmeticType("+", result, number);
        return result !== undefined && isNumeric(result) ? result : UNKNOWN_TYPE;
      }
      case "toString":
      case "toNumber":
      case "toInteger":
      case "toBoolean":
        this.#reportProblems(builtinCallProblems(name, expression, (item) => this.#typeOf(item)));
        return scalarType(CONVERSION_RESULTS.get(name)!);
      case "escapeMarkup":
        if (argument !== undefined && value !== undefined)
          this.#reportUnless(
            value,
            (member) => isScalar(member, "string"),
            argument.value,
            "escapeMarkup(...) takes text (string)",
          );
        return STRING_TYPE;
      case "toDate":
      case "toTime":
      case "toDateTime":
      case "toTimestamp":
        return this.#temporalConversionType(name, expression, values);
      default:
        return UNKNOWN_TYPE;
    }
  }

  /**
   * Checks a conversion to a date or time value (V30 §35): one value, or a date and a time for `toDateTime`, and an
   * optional `default:` of the result type. Text known here must be a valid value, also when a default is given; other
   * text is checked when it is converted.
   */
  #temporalConversionType(
    name: keyof typeof TEMPORAL_CONVERSIONS,
    expression: CallExpression,
    values: readonly StaticType[],
  ): StaticType {
    const conversion = TEMPORAL_CONVERSIONS[name];
    const result: StaticType = { kind: "scalar", name: conversion.result };
    const positional: { readonly value: Expression; readonly type: StaticType }[] = [];
    for (const [index, argument] of expression.arguments.entries()) {
      const type = values[index]!;
      if (argument.kind === "positionalArgument") positional.push({ value: argument.value, type });
      else if (argument.name.name === "default")
        this.#reportUnless(
          type,
          (member) => isScalar(member, conversion.result),
          argument.value,
          `${name}(...) takes ${describeValue(result)} as its 'default:'`,
        );
      else
        this.#report(
          typeCode.unknownNamedArgument,
          `${name}(...) has no parameter '${argument.name.name}'; its only named argument is 'default:'.`,
          argument.name.span,
        );
    }
    const [first, second] = positional;
    if (name === "toDateTime" && positional.length === 2) {
      // A date and a time combine into one date and time.
      for (const [part, kind, position] of [
        [first!, "date", "first"],
        [second!, "time", "second"],
      ] as const)
        this.#reportUnless(
          part.type,
          (member) => isScalar(member, kind),
          part.value,
          `toDateTime(date, time) takes a ${kind} ${position}`,
          () =>
            isScalar(part.type, "string")
              ? ` Convert the text first, as in '${kind === "date" ? "toDate" : "toTime"}(...)'.`
              : "",
        );
      return result;
    }
    if (positional.length !== 1 || first === undefined) {
      this.#report(
        typeCode.argumentCount,
        `${name}(...) takes ${name === "toDateTime" ? "one value, or a date and a time" : "one value"}, received ${positional.length}.`,
        expression.span,
      );
      return result;
    }
    this.#reportUnless(
      first.type,
      (member) => isScalar(member, "string", ...conversion.from),
      first.value,
      `${name}(...) takes ${conversion.takes}`,
      () => conversionMethodFix(name, first.type, first.value),
    );
    const text = staticChoiceValue(first.value)?.value;
    if (typeof text !== "string") return result;
    const parsed: TemporalResult<unknown> = conversion.parse(text);
    if (!parsed.ok)
      this.#report(
        typeCode.invalidOperand,
        parsed.reason === null
          ? `${name}(...) needs ${conversion.text}, not ${JSON.stringify(text)}.`
          : `${name}(...) cannot convert ${JSON.stringify(text)}: ${parsed.reason}.`,
        first.value.span,
      );
    return result;
  }

  /** The type of `object.name`; every member of a union must have the property (ADR 0021 rule 3.5). */
  #propertyType(
    object: StaticType,
    expression: Extract<Expression, { kind: "propertyAccessExpression" }>,
  ): StaticType | PlaceRead {
    const name = expression.property.name;
    const all = members(object);
    const types = all.map((member) => memberPropertyType(member, name));
    const passing = all.filter((_, index) => types[index] !== undefined);
    if (passing.length === all.length)
      // A property or an element is read from the place that keeps it.
      return placeRead(all.length === 1 ? types[0]! : union(types.map((type) => type!)));
    const failing = all.find((_, index) => types[index] === undefined)!;
    if (passing.length > 0) {
      this.#reportMayBe(expression.object, failing, passing);
      return UNKNOWN_TYPE;
    }
    const value = resolved(failing);
    // Text operations and `join` name what to write instead (V30 §8).
    if (MEMBER_CHECKED_KINDS.has(value.kind) || (value.kind === "list" && name === "join")) {
      this.#reportProblems(
        memberProblems(expression.object, failing, expression.property, null, (item) =>
          this.#typeOf(item),
        ),
      );
      return UNKNOWN_TYPE;
    }
    this.#report(
      typeCode.invalidOperand,
      value.kind === "list" || value.kind === "set"
        ? `${value.kind === "list" ? "Lists" : "Sets"} have no property '${name}'; use length, first, last, or random.`
        : value.kind === "timer" || value.kind === "media"
          ? handleMemberMessage(value.kind, name, "read")
          : `${capitalize(describeValue(value))} has no property '${name}'.${
              // A timestamp has no local fields until it is converted through the player's zone.
              isScalar(value, "timestamp") && temporalFieldType("datetime", name) !== undefined
                ? ` Convert it first, as in '${expressionLabel(expression.object) ?? "value"}.toDateTime().${name}'.`
                : ""
            }`,
      expression.property.span,
    );
    return UNKNOWN_TYPE;
  }

  /** Checks `object[index]`: only lists are indexed, every member of a union must be one, and an index is whole. */
  #checkIndex(
    object: StaticType,
    objectExpression: Expression,
    index: StaticType,
    expression: Expression,
  ): void {
    if (members(object).some((member) => isKnown(member) && resolved(member).kind !== "list")) {
      this.#reportUnless(
        object,
        (member) => !isKnown(member) || resolved(member).kind === "list",
        objectExpression,
        "Only a list can be indexed",
      );
      return;
    }
    const position = nonNullTypeForUse(index);
    if (isScalar(position, "number"))
      this.#report(
        typeCode.invalidOperand,
        `A list index must be a whole number (integer), but this is ${describeValue(position)}.${this.#widenedNote(expression)}${ROUND_FIX}.`,
        expression.span,
      );
    else
      this.#reportUnless(
        index,
        (member) => isScalar(member, "integer"),
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
      return expression.interactionKind === "number"
        ? NUMBER_TYPE
        : expression.interactionKind === "integer"
          ? INTEGER_TYPE
          : STRING_TYPE;
    }
    // `choose` returns a button's value: one written before `:`, or else what gives the button, with its type. Each
    // button's value is also kept when the source shows it, so a comparison with another value can be checked (C5).
    const values: StaticType[] = [];
    let literals: (ScalarValue | null)[] | null = [];
    const add = (type: StaticType, literal: ScalarValue | null | undefined): void => {
      values.push(type);
      if (literal === undefined) literals = null;
      else literals?.push(literal);
    };
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
      const writtenValue =
        option.value === null
          ? undefined
          : option.value.kind === "identifier"
            ? option.value.name
            : option.value.value;
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
          if (written === null) add(value, buttonLiteral(element));
        }
        // An empty list or set gives no buttons, so its written value is never returned.
        if (written !== null && content.elements.length > 0) add(written, writtenValue);
        continue;
      }
      const type = yield* compileChild(this.#expressionTask(option.expression, scope));
      const value = resolved(nonNullType(type));
      const parts = members(nonNullType(type)).map(resolved);
      if (parts.some((part) => part.kind === "list" || part.kind === "set")) {
        // Each member gives buttons: a collection its elements, a value itself. The elements of a computed collection
        // are not visible here: a choice object among them may return its value or its text, so only scalar
        // elements give a known result type.
        // Every element of a computed list or set gives one button, so each must be a value or a choice object.
        const accepted =
          this.#choiceEntry(option.expression, type, false) !== UNKNOWN_TYPE &&
          !this.#checkElements(
            option.expression,
            type,
            (element) => isShowable(element) || resolved(element).kind === "object",
            () =>
              this.#report(
                typeCode.invalidInteractionChoice,
                "A choice list element must be text, a number, true, false, null, a duration, a date or time value, or a choice object { value?, text, background? }.",
                option.expression.span,
              ),
          );
        const results = parts.map((part) => {
          const button =
            part.kind === "list" || part.kind === "set" ? resolved(part.element) : part;
          // A computed collection's element type is copied, so the result stays apart from the collection.
          return button.kind === "object" ? UNKNOWN_TYPE : copyType(button);
        });
        add(
          written ??
            (accepted && !isNullable(type) ? (joinTypes(results) ?? UNKNOWN_TYPE) : UNKNOWN_TYPE),
          writtenValue,
        );
        // The buttons of a collection held in a variable are not visible here.
        if (written === null) literals = null;
        continue;
      }
      if (isKnown(value)) buttons += 1;
      // The option is kept as it was evaluated: a later option may still change the place it was read from.
      const entry = this.#choiceEntry(option.expression, this.#capture(option.expression), false);
      add(written ?? entry, written === null ? buttonLiteral(option.expression) : writtenValue);
    }
    if (buttons > MAX_INTERACTION_OPTION_ENTRIES)
      this.#report(
        typeCode.invalidInteractionChoice,
        `A choice can show at most ${MAX_INTERACTION_OPTION_ENTRIES} buttons.`,
        expression.span,
      );
    if (values.length === 0) return UNKNOWN_TYPE;
    const known: readonly (ScalarValue | null)[] | null = literals;
    const joined = joinTypes(values);
    // Integers and numbers together are numbers. Values of other different types are a union that only a place
    // declared with a union type may keep (#511 C2).
    // A list or set option that mixes types is reported as that literal already.
    // An option that already holds values of different types, such as a list of a union type, mixes them too.
    // The known values decide this, whatever an option of unknown type adds and in whichever order the options come.
    const knownValues = union(values.flatMap((value) => members(value).filter(isKnown)));
    if (
      (joined === undefined || mixesFamilies(joined) || mixesFamilies(knownValues)) &&
      !expression.options.some((option) => this.#mixedLiterals.has(unwrap(option.expression)))
    )
      this.#mixedChoices.set(expression, plainType(knownValues));
    if (known === null) return joined ?? union(values);
    return restrictedChoice(values, known);
  }

  /**
   * Reports a `choose` whose buttons return values of different types where its value would decide a type, such as
   * an unannotated `let`, an inferred function result, or a parameter without a type (#511 C2).
   */
  #reportMixedChoice(expression: Expression, fix: (written: string) => string): void {
    const mixed = this.#mixedChoices.get(unwrap(expression));
    if (mixed === undefined) return;
    this.#report(
      typeCode.mixedTypes,
      `This choose returns ${describeValue(mixed)}. A place keeps one type; ${fix(typeName(mixed))}.`,
      expression.span,
    );
  }

  /**
   * Checks what gives one button: a value, or a choice object `{ value?, text, background? }` whose value, else its
   * text, the button returns. Returns that value's type; a computed choice object's value is not known.
   */
  #choiceEntry(entry: Expression, type: StaticType, inList: boolean): StaticType {
    const value = resolved(nonNullType(type));
    // A button comes from a value or a choice object; a list or set gives buttons only as a whole option.
    const accepted = (member: StaticType): boolean => {
      const kind = resolved(member).kind;
      return (
        isShowable(member) || kind === "object" || (!inList && (kind === "list" || kind === "set"))
      );
    };
    const rejected = this.#checkMembers(entry, type, accepted, (member) =>
      this.#report(
        typeCode.invalidInteractionChoice,
        inList && (member.kind === "list" || member.kind === "set")
          ? "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set."
          : "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
        entry.span,
      ),
    );
    if (rejected) return UNKNOWN_TYPE;
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
        this.#checkMembers(property.value, propertyType, isShowable, () =>
          this.#report(
            typeCode.invalidInteractionChoice,
            "A choice value must be text, a number, true, false, null, a duration, or a date or time value.",
            property.value.span,
          ),
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
      // `${...}` selects one element of a list, so a list is shown too, and its elements must be shown.
      const reported = this.#checkMembers(
        expression,
        type,
        (member) => isShowable(member) || resolved(member).kind === "list",
        (member) =>
          this.#report(
            typeCode.unshowableValue,
            `"\${...}" cannot show ${describeValue(member)}. It shows text, numbers, true, false, null, durations, and date and time values, and selects one element of a list.`,
            expression.span,
          ),
      );
      if (!reported)
        this.#checkElements(expression, type, isShowable, () =>
          this.#report(
            typeCode.unshowableValue,
            "An interpolated list may contain only text, numbers, true, false, null, durations, and date and time values, because one element is shown as text.",
            expression.span,
          ),
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
      this.#checkMembers(element, this.#typeOf(element), isShowable, () =>
        this.#report(
          typeCode.unshowableValue,
          "An interpolated list may contain only text, numbers, true, false, null, durations, and date and time values, because one element is shown as text.",
          element.span,
        ),
      );
  }

  /** A button background is a colour in text; `null` is no colour either, so an optional type is checked by its value. */
  /** A button's label is shown text, and its options are checked in source order. As a value it is a duration. */
  *#showButtonTask(parts: ShowButtonParts, scope: Scope): CompileTask<void> {
    this.#checkShownText(
      parts.label,
      yield* compileChild(this.#expressionTask(parts.label, scope)),
      "a button label",
    );
    for (const option of showButtonOptions(parts)) {
      const type = yield* compileChild(this.#expressionTask(option.value, scope));
      if (option.name === "background") this.#checkBackground(option.value, type);
      else
        this.#reportUnless(
          type,
          (member) => isNumeric(member) || isScalar(member, "duration"),
          option.value,
          "A showButton timeout is a duration such as '30 s', or a number of seconds",
        );
    }
  }

  #checkBackground(expression: Expression, type: StaticType): void {
    if (this.#reportedMayBe(expression, type, (member) => isScalar(member, "string"))) return;
    if (isKnown(nonNullType(type)) && !isScalar(nonNullType(type), "string"))
      this.#report(
        typeCode.invalidInteractionChoice,
        "Expected an opaque CSS button background colour.",
        expression.span,
      );
  }

  /**
   * Checks every known member of a value's type except `null` (ADR 0021 rule 3.5): when only some are accepted, the
   * author must test which one it holds first; when none is, `reject` reports the first. Returns whether anything was
   * reported.
   */
  #checkMembers(
    expression: Expression,
    type: StaticType,
    accepts: (member: StaticType) => boolean,
    reject: (member: StaticType) => void,
  ): boolean {
    if (this.#reportedMayBe(expression, type, accepts)) return true;
    const known = members(nonNullType(type)).filter(isKnown);
    if (known.length === 0 || known.some(accepts)) return false;
    reject(resolved(known[0]!));
    return true;
  }

  /**
   * Checks the known elements of the lists and sets a value of `type` may be, which are shown or give buttons one at a
   * time: reports that the author must test which collection it is when only some are accepted, else rejects them when
   * none are. Returns whether it reported.
   */
  #checkElements(
    expression: Expression,
    type: StaticType,
    accepts: (element: StaticType) => boolean,
    reject: () => void,
  ): boolean {
    const passing: StaticType[] = [];
    const failing: StaticType[] = [];
    for (const member of members(type).map(resolved)) {
      // A member that is not a collection, null included, passed the check of the whole value, so it is a way the value
      // is accepted.
      if (member.kind !== "list" && member.kind !== "set") {
        if (isKnown(member)) passing.push(member);
        continue;
      }
      for (const element of members(member.element).filter(isKnown))
        (accepts(element) ? passing : failing).push({ kind: member.kind, element });
    }
    if (failing.length === 0) return false;
    if (passing.length === 0) reject();
    else this.#reportMayBe(expression, failing[0]!, passing);
    return true;
  }

  /**
   * For a value of a union type of which only some members are accepted, reports that the author must test which
   * member it holds first (ADR 0021 rule 3.5), and returns whether it did.
   */
  #reportedMayBe(
    expression: Expression,
    type: StaticType,
    accepts: (member: StaticType) => boolean,
  ): boolean {
    const all = members(nonNullType(type)).filter(isKnown);
    const passing = all.filter(accepts);
    if (passing.length === 0 || passing.length === all.length) return false;
    this.#reportMayBe(
      expression,
      all.find((member) => !accepts(member))!,
      passing,
    );
    return true;
  }

  /** Only `${...}` selects from a list; a list in a text field is an error, at runtime when it is not known here. */
  #checkShownText(expression: Expression, type: StaticType, field: string): void {
    this.#checkMembers(expression, type, isShowable, (member) =>
      member.kind === "list"
        ? this.#report(
            typeCode.listInText,
            `A list cannot be ${field}. Select one element with "\${list}" or list.random.`,
            expression.span,
          )
        : this.#report(
            typeCode.unshowableValue,
            `${capitalize(field)} cannot be ${describeValue(member)}.`,
            expression.span,
          ),
    );
  }

  /**
   * A default answer must be an answer the field accepts: text for askText, a number for askNumber, and a whole number
   * for askInteger. The compiler rejects a default it knows is wrong; the runtime checks the others when the field opens.
   */
  #checkInteractionDefault(
    kind: "text" | "number" | "integer",
    expression: Expression,
    type: StaticType,
  ): void {
    const name = expression.kind === "identifier" ? expression.name : null;
    const holds = !isKnown(type)
      ? ""
      : name === null
        ? `, not ${describeValue(type)}`
        : `, but '${name}' holds ${describeValue(type)}`;
    const expected =
      kind === "integer" ? INTEGER_TYPE : kind === "number" ? NUMBER_TYPE : STRING_TYPE;
    const fix =
      resolved(type).kind === "null"
        ? EMPTY_FIELD_FIX
        : isNullable(type) && isAssignable(expected, nonNullType(type))
          ? (checkFirstFix(expected, type, expression) ?? "")
          : kind === "text"
            ? textDefaultFix(expression, name)
            : numberDefaultFix(expression);
    if (kind === "integer") {
      // A non-whole default is never rounded; a number variable may be one that widened (rule 1.2).
      if (isScalar(nonNullTypeForUse(type), "number"))
        this.#report(
          typeCode.invalidInteractionDefault,
          `The default answer of askInteger must be a whole number (integer)${holds}.${this.#widenedNote(expression)}${ROUND_FIX}.`,
          expression.span,
        );
      else if (!isAssignable(INTEGER_TYPE, type))
        this.#report(
          typeCode.invalidInteractionDefault,
          `The default answer of askInteger must be a whole number (integer)${holds}.${resolved(type).kind === "null" || isNullable(type) ? fix : " Use a whole number, such as 'default: 10'."}`,
          expression.span,
        );
      else if (!Number.isSafeInteger(staticNumber(expression) ?? 0))
        this.#report(
          typeCode.invalidInteractionDefault,
          `The default answer of askInteger must be a whole number from ${-Number.MAX_SAFE_INTEGER} through ${Number.MAX_SAFE_INTEGER}. Use a smaller number, or remove 'default:'.`,
          expression.span,
        );
      return;
    }
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

  #reportTime(expression: Expression, type: StaticType, unit: boolean, range = false): void {
    const isRange = (member: StaticType): boolean => range && resolved(member).kind === "range";
    if (unit)
      this.#reportUnless(
        type,
        (member) => isNumeric(member) || isRange(member),
        expression,
        "A time before a unit is a number",
      );
    else
      this.#reportUnless(
        type,
        (member) => isNumeric(member) || isScalar(member, "duration") || isRange(member),
        expression,
        range
          ? "A timer duration is a duration such as '30 s', a number of seconds, or a range of whole seconds"
          : "A time is a duration such as '30 s', or a number of seconds",
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
    this.#reportTime(timer.duration, duration, timer.unit !== null, true);
    if (timer.label !== null)
      this.#checkShownText(
        timer.label,
        yield* compileChild(this.#expressionTask(timer.label, scope)),
        "a timer label",
      );
    if (timer.handler !== null) this.#handlers.push({ block: timer.handler, selfHandle: null });
  }

  *#mediaTask(media: MediaParts, scope: Scope, selfHandle: string | null): CompileTask<StaticType> {
    // Media first waits for the previous message's pacing, and later for loading; handlers may run at both.
    this.#suspend();
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
    this.#suspend();
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
  *#conditionTask(expression: Expression, scope: Scope): CompileTask<Branches> {
    const branches = yield* compileChild(this.#branchTask(expression, scope));
    this.#requireBoolean(branches.type, expression, "A condition must be true or false (boolean)");
    return branches;
  }

  *#requireTask(
    expression: Expression,
    scope: Scope,
    accepts: (type: StaticType) => boolean,
    rule: string,
  ): CompileTask<void> {
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    this.#reportUnless(type, accepts, expression, rule);
  }

  /**
   * Records a runtime check where a value whose type has unknown parts is stored in a place (ADR 0021 rule 1.7). The
   * place's type is read after the whole check, because a later value can still decide it.
   */
  #recordRuntimeCheck(
    site: RuntimeCheckSite,
    place: StaticType,
    label: string,
    value: StaticType,
  ): void {
    if (containsType(value, (part) => part.kind === "unknown"))
      this.#runtimeChecks.push({ site, place, label });
  }

  // Reports ----------------------------------------------------------------------------------------------------------

  /** Conditions and `and`/`or`/`not` operands must be true or false; there is no truthiness. */
  #requireBoolean(type: StaticType, expression: Expression, rule: string): void {
    const value = nonNullTypeForUse(type);
    this.#reportUnless(
      type,
      (member) => isScalar(member, "boolean"),
      expression,
      rule,
      () => conditionFix(value, expression),
    );
  }

  /**
   * Reports `rule` when a known value does not satisfy it. Every member of a union must satisfy it; when only some do,
   * the message names the test the author needs (ADR 0021 rule 3.5).
   */
  #reportUnless(
    type: StaticType,
    accepts: (member: StaticType) => boolean,
    expression: Expression,
    rule: string,
    fix: () => string = () => "",
  ): void {
    const value = nonNullTypeForUse(type);
    if (!isKnown(value)) return;
    // A possibly null value needs a check first, unless null is accepted too (owner decision on #504 Q1).
    const all = members(type);
    const passing = all.filter(accepts);
    if (passing.length === all.length) return;
    if (passing.length > 0) {
      const failing = all.filter((member) => !accepts(member));
      this.#reportMayBe(
        expression,
        failing.find((member) => member.kind !== "null") ?? failing[0]!,
        passing,
      );
      return;
    }
    this.#report(
      typeCode.invalidOperand,
      `${rule}, but this is ${describeValue(value)}.${fix()}`,
      expression.span,
    );
  }

  /** A value that may be of a member type the operation does not support: name the test that makes it safe. */
  #reportMayBe(expression: Expression, failing: StaticType, passing: readonly StaticType[]): void {
    // Only a plain variable narrows, so a property or element is first kept in a variable.
    const node = unwrap(expression);
    const label = node.kind === "identifier" ? node.name : null;
    // A value that may be null is checked with `!= null`, which also narrows it.
    const test = failing.kind === "null" ? "!= null" : `is ${typeName(union(passing))}`;
    this.#report(
      typeCode.invalidOperand,
      label === null
        ? `This value may be ${describeValue(failing)}. Keep it in a variable and check it first, as in: if value ${test} { ... }`
        : `'${label}' may be ${describeValue(failing)}. Check it first: if ${label} ${test} { ... }`,
      expression.span,
    );
  }

  /**
   * Reports a value that a set cannot hold: a set holds only text, numbers, true or false, date and time values, and
   * null (V30 §16). A value of unknown type is checked when the script runs. Returns whether the value may be held.
   */
  #checkSetElement(expression: Expression, type: StaticType): boolean {
    const rejected = members(type).find((member) => isKnown(member) && !isSetElement(member));
    if (rejected === undefined) return true;
    this.#report(
      typeCode.invalidSetElement,
      `A set holds only text, numbers, true or false, date and time values, or null, so it cannot hold ${describeValue(rejected)}.`,
      expression.span,
    );
    return false;
  }

  /** Reports list and set literals that mix types and were not stored in a place of a declared element type. */
  #reportMixedLiterals(): void {
    for (const [literal, types] of this.#mixedLiterals) {
      const kind = literal.kind === "setLiteral" ? "set" : "list";
      const first = types[0]!;
      const other = types.find((type) => joinTypes([first, type]) === undefined) ?? types[1]!;
      const written = typeName({ kind, element: union(types) });
      const name = this.#declaredBy.get(literal);
      const property = misfitProperty(first, other);
      // A property type has no written form, so objects that disagree need one type for that property.
      const fix =
        property !== undefined
          ? `give '${property.name}' one type in every element`
          : `to keep both, declare a union type, as in '${name === undefined ? `let values: ${written}` : `let ${name}: ${written}`} = ...'`;
      this.#report(
        typeCode.mixedTypes,
        `This ${kind} mixes ${mixDescription(first, other)}. A ${kind} holds one type; ${fix}.`,
        literal.span,
      );
    }
    this.#mixedLiterals.clear();
  }

  #reportProblems(problems: readonly OperationProblem[]): void {
    for (const problem of problems)
      this.#report(
        typeCode[problem.kind],
        `${problem.message}${problem.widened === undefined ? "" : this.#widenedNote(problem.widened)}${problem.fix ?? ""}`,
        problem.span,
      );
  }

  /**
   * Removes diagnostics since `start` that repeat an earlier one since then with the same code and span, such as the
   * same argument problem found for each member of a union receiver.
   */
  #keepFirstDiagnostics(start: number): void {
    const seen = new Set<string>();
    const kept = this.diagnostics.slice(start).filter((diagnostic) => {
      const key = `${diagnostic.code} ${diagnostic.span.start.offset} ${diagnostic.span.end.offset}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.diagnostics.splice(start, this.diagnostics.length - start, ...kept);
  }

  #report(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push(createDiagnostic(DiagnosticSeverity.Error, code, message, span));
  }
}

// Flow ---------------------------------------------------------------------------------------------------------------

/**
 * What is known about variables at the current point of the checked code: the narrowed types that differ from their
 * declared or inferred types (ADR 0021 rule 5). The facts are persistent, so a branch starts from a kept state and a
 * path that alone continues is adopted as it is; only where paths meet are the variables they changed compared.
 */
class Flow {
  #facts: FactNode | undefined;
  /** The facts of variables that other code may assign, so a suspension finds them without a full scan. */
  #shared: FactNode | undefined;
  /** The variables changed so far, newest first, to find what changed between two states. */
  #log: FlowLog | null = null;
  /** A number for each variable this flow has seen, its key in the facts. */
  readonly #ids = new Map<Variable, number>();

  #id(variable: Variable): number {
    let id = this.#ids.get(variable);
    if (id === undefined) {
      id = this.#ids.size;
      this.#ids.set(variable, id);
    }
    return id;
  }

  get(variable: Variable): StaticType | undefined {
    return factOf(this.#facts, this.#id(variable))?.type;
  }

  set(variable: Variable, type: StaticType | undefined): void {
    const id = this.#id(variable);
    if (factOf(this.#facts, id)?.type === type) return;
    const fact = type === undefined ? undefined : { variable, type };
    this.#facts = withFact(this.#facts, id, fact);
    if (variable.shared) this.#shared = withFact(this.#shared, id, fact);
    this.#log = { variable, older: this.#log };
  }

  apply(changes: Changes | null): void {
    if (changes !== null) for (const [variable, type] of changes) this.set(variable, type);
  }

  mark(): FlowState {
    return { facts: this.#facts, shared: this.#shared, log: this.#log };
  }

  restore(state: FlowState): void {
    this.#facts = state.facts;
    this.#shared = state.shared;
    this.#log = state.log;
  }

  /** What changed from `from` to `to`, a later state of the same path. */
  between(from: FlowState, to: FlowState): Changes {
    const changes = new Map<Variable, StaticType | undefined>();
    for (let entry = to.log; entry !== null && entry !== from.log; entry = entry.older)
      if (!changes.has(entry.variable))
        changes.set(entry.variable, factOf(to.facts, this.#id(entry.variable))?.type);
    return changes;
  }

  /** What changed since `start`, with `extra` changes on top. */
  since(start: FlowState, extra: Changes | null = null): Changes {
    const changes = new Map(this.between(start, this.mark()));
    if (extra !== null) for (const [variable, type] of extra) changes.set(variable, type);
    return changes;
  }

  /** Returns to `start` and returns what had changed since. */
  undo(start: FlowState): Changes {
    const changes = this.since(start);
    this.restore(start);
    return changes;
  }

  forget(test: (variable: Variable) => boolean): void {
    for (const fact of allFacts(test === sharedVariable ? this.#shared : this.#facts))
      if (test(fact.variable)) this.set(fact.variable, undefined);
  }

  /**
   * Where paths meet, each given by what it changed from the current flow: a variable stays narrowed only when every
   * reaching path narrowed it. Returns what to change, or `null` when no path reaches.
   */
  join(paths: readonly (Changes | null)[]): Changes | null {
    const reached = paths.filter((path): path is Changes => path !== null);
    if (reached.length === 0) return null;
    const variables = new Set<Variable>();
    for (const path of reached) for (const variable of path.keys()) variables.add(variable);
    const joined = new Map<Variable, StaticType | undefined>();
    for (const variable of variables) {
      const current = this.get(variable);
      const types: StaticType[] = [];
      for (const path of reached) {
        const type = path.has(variable) ? path.get(variable) : current;
        if (type === undefined) break;
        types.push(type);
      }
      let type =
        types.length < reached.length
          ? undefined
          : types.every((other) => other === types[0])
            ? types[0]
            : union(types);
      // A fact that allows every declared value says nothing more than the declaration.
      if (type !== undefined && coversType(type, variable.type)) type = undefined;
      if (type !== current) joined.set(variable, type);
    }
    return joined;
  }
}

/** A kept state of a {@link Flow}, to return to or to compare with. */
interface FlowState {
  readonly facts: FactNode | undefined;
  readonly shared: FactNode | undefined;
  readonly log: FlowLog | null;
}

interface FlowLog {
  readonly variable: Variable;
  readonly older: FlowLog | null;
}

interface Fact {
  readonly variable: Variable;
  readonly type: StaticType;
}

/** A node of a persistent map from variable numbers to facts, with 16 slots per level; a change copies one path. */
interface FactNode {
  readonly slots: readonly (FactNode | undefined)[];
  readonly fact: Fact | undefined;
}

const FACT_LEVELS = 7;
const NO_SLOTS: readonly (FactNode | undefined)[] = Object.freeze([]);

function factOf(root: FactNode | undefined, id: number): Fact | undefined {
  let node = root;
  for (let level = FACT_LEVELS - 1; level >= 0 && node !== undefined; level -= 1)
    node = node.slots[(id >>> (4 * level)) & 15];
  return node?.fact;
}

function withFact(
  root: FactNode | undefined,
  id: number,
  fact: Fact | undefined,
): FactNode | undefined {
  const path: (FactNode | undefined)[] = [];
  let node = root;
  for (let level = FACT_LEVELS - 1; level >= 0; level -= 1) {
    path.push(node);
    node = node?.slots[(id >>> (4 * level)) & 15];
  }
  let built: FactNode | undefined = fact === undefined ? undefined : { slots: NO_SLOTS, fact };
  for (let level = 0; level < FACT_LEVELS; level += 1) {
    const parent = path[FACT_LEVELS - 1 - level];
    const slots: (FactNode | undefined)[] =
      parent === undefined ? Array.from({ length: 16 }, () => undefined) : [...parent.slots];
    slots[(id >>> (4 * level)) & 15] = built;
    built = slots.some((slot) => slot !== undefined) ? { slots, fact: undefined } : undefined;
  }
  return built;
}

function allFacts(root: FactNode | undefined): Fact[] {
  const facts: Fact[] = [];
  const pending = root === undefined ? [] : [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.fact !== undefined) facts.push(node.fact);
    for (const slot of node.slots) if (slot !== undefined) pending.push(slot);
  }
  return facts;
}

function sharedVariable(variable: Variable): boolean {
  return variable.shared;
}

/** What one iteration of a loop may do before the next test: the variables it assigns, and whether it may suspend. */
interface LoopEffects {
  readonly assigned: ReadonlySet<string>;
  readonly suspends: boolean;
}

const SUSPENDING_STATEMENTS: ReadonlySet<Statement["kind"]> = new Set([
  "sayStatement",
  "showButtonStatement",
  "waitStatement",
  "timerStatement",
  "playMediaStatement",
  "showImageStatement",
  "hideImageStatement",
  "saveStatement",
  "deleteStatement",
]);

/** What a program's loops and functions may change (ADR 0021 rule 5.5). */
interface ProgramEffects {
  /** Names that function bodies and timer or media blocks assign. */
  readonly shared: ReadonlySet<string>;
  /** The effects of each loop, by its body; a `while` loop includes its condition. */
  readonly loops: ReadonlyMap<Block, LoopEffects>;
}

interface LoopNode {
  readonly body: Block;
  readonly parent: LoopNode | null;
  readonly assigned: Set<string>;
  suspends: boolean;
}

type EffectWork =
  | { readonly statement: Statement; readonly loop: LoopNode | null; readonly inside: boolean }
  | { readonly expression: Expression; readonly loop: LoopNode | null; readonly inside: boolean };

/**
 * Collects in one pass the names that functions and blocks assign, and the effects of every loop. A loop's effects
 * include those of the loops inside it, but not those of timer or media blocks it starts, which run later.
 */
function programEffects(program: Program): ProgramEffects {
  const shared = new Set<string>();
  const nodes: LoopNode[] = [];
  const work: EffectWork[] = [];
  const enter = (
    statements: readonly Statement[],
    loop: LoopNode | null,
    inside: boolean,
  ): void => {
    for (let index = statements.length - 1; index >= 0; index -= 1)
      work.push({ statement: statements[index]!, loop, inside });
  };
  const loopNode = (body: Block, parent: LoopNode | null): LoopNode => {
    const node: LoopNode = { body, parent, assigned: new Set(), suspends: false };
    nodes.push(node);
    return node;
  };
  const handlers = (node: Statement | Expression): void => {
    for (const block of handlerBlocks(node)) enter(block.statements, null, true);
  };
  enter(program.statements, null, false);
  while (work.length > 0) {
    const item = work.pop()!;
    const { loop, inside } = item;
    if ("expression" in item) {
      const expression = item.expression;
      if (
        loop !== null &&
        (expression.kind === "interactionExpression" ||
          expression.kind === "showButtonExpression" ||
          expression.kind === "timerExpression" ||
          expression.kind === "playMediaExpression" ||
          (expression.kind === "callExpression" && !isPureBuiltinCall(expression)))
      )
        loop.suspends = true;
      // A method that changes a list or set changes the variable that holds it, also called in parentheses.
      const callee = expression.kind === "callExpression" ? unwrap(expression.callee) : null;
      if (
        callee?.kind === "propertyAccessExpression" &&
        COLLECTION_CHANGES.has(callee.property.name)
      ) {
        const root = rootName(callee.object);
        if (root !== null) {
          if (inside) shared.add(root);
          loop?.assigned.add(root);
        }
      }
      handlers(expression);
      for (const part of expressionParts(expression)) work.push({ expression: part, loop, inside });
      continue;
    }
    const statement = item.statement;
    if (loop !== null && SUSPENDING_STATEMENTS.has(statement.kind)) loop.suspends = true;
    if (statement.kind === "assignmentStatement") {
      // A store into an element or property changes the variable that holds it, too.
      const root = rootName(statement.target);
      if (root !== null) {
        if (inside) shared.add(root);
        loop?.assigned.add(root);
      }
      // A timer or media property write may run a block at once.
      if (statement.target.kind !== "identifier" && loop !== null) loop.suspends = true;
    }
    handlers(statement);
    switch (statement.kind) {
      case "functionDeclaration":
        enter(statement.body.statements, null, true);
        continue;
      case "whileStatement": {
        const node = loopNode(statement.body, loop);
        enter(statement.body.statements, node, inside);
        work.push({ expression: statement.condition, loop: node, inside });
        continue;
      }
      case "repeatStatement":
      case "forStatement":
        enter(statement.body.statements, loopNode(statement.body, loop), inside);
        break;
      default:
        enter(nestedStatements(statement), loop, inside);
    }
    for (const expression of statementExpressions(statement))
      work.push({ expression, loop, inside });
  }
  // Inner loops come after the loops around them, so walking backwards adds each loop's effects to its parent.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (node.parent === null) continue;
    for (const name of node.assigned) node.parent.assigned.add(name);
    node.parent.suspends ||= node.suspends;
  }
  return {
    shared,
    loops: new Map(
      nodes.map((node) => [node.body, { assigned: node.assigned, suspends: node.suspends }]),
    ),
  };
}

/** Methods that change the list or set they are called on. */
/** The value kinds an operand of unknown type might be, to tell whether a known operand could combine with any. */
const OPERAND_KINDS: readonly StaticType[] = [
  INTEGER_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  BOOLEAN_TYPE,
  DURATION_TYPE,
  DATE_TYPE,
  TIME_TYPE,
  DATETIME_TYPE,
  TIMESTAMP_TYPE,
];

/** Whether a variable of this type holds a list or set whose element type no value decided yet. */
function hasUndecidedElements(type: StaticType): boolean {
  return members(nonNullType(type)).some((member) => {
    const value = resolved(member);
    return (
      (value.kind === "list" || value.kind === "set") && resolved(value.element).kind === "open"
    );
  });
}

const COLLECTION_CHANGES: ReadonlySet<string> = new Set([
  "add",
  "remove",
  "clear",
  "removeAt",
  "removeFirst",
  "removeLast",
]);

/**
 * The members of a variable's own type that hold what it is known to hold, such as `integer[]` of `integer[] | string[]`
 * for a list of integers. Every list type holds the empty list, so an overlap decides only when no member holds it.
 */
function ownMembers(variable: Variable, known: StaticType): StaticType[] {
  const all = members(variable.type);
  const kept = new Set<StaticType>();
  for (const part of members(known)) {
    const holding = all.filter((member) => coversType(member, part));
    for (const member of holding.length > 0
      ? holding
      : all.filter((other) => narrowTo(other, part).kind !== "never"))
      kept.add(member);
  }
  return all.filter((member) => kept.has(member));
}

/** The variable a place belongs to, such as `xs` for `xs[0].name`, or `null` for a place no variable holds. */
function rootName(expression: Expression): string | null {
  let node = unwrap(expression);
  while (node.kind === "propertyAccessExpression" || node.kind === "indexExpression")
    node = unwrap(node.object);
  return node.kind === "identifier" ? node.name : null;
}

/** The statements of the blocks that run as part of a statement: branches and loop bodies, not handler blocks. */
function nestedStatements(statement: Statement): readonly Statement[] {
  switch (statement.kind) {
    case "ifStatement":
      return [
        ...statement.thenBlock.statements,
        ...(statement.elseBlock === null
          ? []
          : statement.elseBlock.kind === "ifStatement"
            ? [statement.elseBlock]
            : statement.elseBlock.statements),
      ];
    case "whileStatement":
    case "repeatStatement":
    case "forStatement":
      return statement.body.statements;
    case "switchStatement":
      return [
        ...statement.cases.flatMap((switchCase) => switchCase.body.statements),
        ...(statement.defaultBlock?.statements ?? []),
      ];
    default:
      return [];
  }
}

/** The timer or media blocks that a statement or expression registers. */
function handlerBlocks(node: Statement | Expression): readonly Block[] {
  if (node.kind === "timerStatement" || node.kind === "timerExpression")
    return node.handler === null ? [] : [node.handler];
  if (node.kind === "playMediaStatement" || node.kind === "playMediaExpression")
    return mediaHandlerBlocks(node);
  return [];
}

/** The expressions a statement evaluates itself, outside its nested blocks. */
function statementExpressions(statement: Statement): readonly Expression[] {
  switch (statement.kind) {
    case "letStatement":
      return [statement.initializer];
    case "assignmentStatement":
      return statement.target.kind === "identifier"
        ? [statement.value]
        : [...expressionChildren(statement.target), statement.value];
    case "expressionStatement":
      return [statement.expression];
    case "switchStatement":
      return [statement.subject, ...statement.cases.flatMap((switchCase) => switchCase.values)];
    case "speakerDeclaration":
      return statement.properties.map((property) => property.value);
    case "sayStatement":
      return [
        ...(statement.presentation === null ? [] : [statement.presentation]),
        statement.value,
        ...(statement.pacing === null || statement.pacing === "instant" ? [] : [statement.pacing]),
      ];
    case "showButtonStatement":
      return showButtonOperands(statement);
    case "waitStatement":
      return [statement.duration];
    case "timerStatement":
      return timerOperands(statement);
    case "playMediaStatement":
      return mediaOperands(statement);
    case "showImageStatement":
      return [statement.image];
    case "saveStatement":
      return [statement.value, statement.key];
    case "deleteStatement":
      return [statement.key];
    case "ifStatement":
    case "whileStatement":
      return [statement.condition];
    case "repeatStatement":
      return [statement.count];
    case "forStatement":
      return [statement.iterable];
    case "returnStatement":
      return statement.value === null ? [] : [statement.value];
    default:
      return [];
  }
}

/** The direct subexpressions of an expression, including interaction operands. */
function expressionParts(expression: Expression): readonly Expression[] {
  if (expression.kind === "interactionExpression")
    return [
      ...(expression.hint === null ? [] : [expression.hint]),
      ...(expression.defaultValue === null ? [] : [expression.defaultValue]),
      ...expression.options.map((option) => option.expression),
    ];
  if (expression.kind === "showButtonExpression") return showButtonOperands(expression);
  return expressionChildren(expression);
}

function showButtonOperands(parts: ShowButtonParts): readonly Expression[] {
  return [parts.label, ...showButtonOptions(parts).map((option) => option.value)];
}

function timerOperands(timer: TimerParts): readonly Expression[] {
  return [
    ...(typeof timer.display === "object" && timer.display !== null ? [timer.display] : []),
    timer.duration,
    ...(timer.label === null ? [] : [timer.label]),
  ];
}

/** The built-in conversions to date and time values: what each converts, and the ISO text it reads (V30 §35). */
const TEMPORAL_CONVERSIONS = {
  toDate: {
    result: "date",
    from: ["date", "datetime"],
    takes: "date text, a date, or a date and time",
    text: 'ISO date text such as "2026-10-04"',
    parse: parseIsoDate,
  },
  toTime: {
    result: "time",
    from: ["time", "datetime"],
    takes: "time text, a time, or a date and time",
    text: 'ISO time text such as "14:30"',
    parse: parseIsoTime,
  },
  toDateTime: {
    result: "datetime",
    from: ["datetime"],
    takes: "date and time text, a date and time, or a date and a time",
    text: 'local ISO date and time text without an offset, such as "2026-10-04T18:00"',
    parse: parseIsoDateTime,
  },
  toTimestamp: {
    result: "timestamp",
    from: ["timestamp"],
    takes: "timestamp text or a timestamp",
    text: 'ISO timestamp text with Z or an offset, such as "2026-10-04T12:30:00Z"',
    parse: parseIsoTimestamp,
  },
} as const satisfies Record<
  string,
  {
    readonly result: ScalarTypeName;
    readonly from: readonly ScalarTypeName[];
    readonly takes: string;
    readonly text: string;
    readonly parse: (text: string) => TemporalResult<unknown>;
  }
>;

/** A local date and time and a timestamp convert into each other with a method, through the player's zone. */
function conversionMethodFix(
  name: keyof typeof TEMPORAL_CONVERSIONS,
  type: StaticType,
  expression: Expression,
): string {
  const method =
    name === "toTimestamp" && isScalar(type, "datetime")
      ? "toTimestamp"
      : name === "toDateTime" && isScalar(type, "timestamp")
        ? "toDateTime"
        : null;
  return method === null
    ? ""
    : ` Convert it with '${expressionLabel(expression) ?? "value"}.${method}()'.`;
}

const PURE_BUILTINS: ReadonlySet<string> = new Set([
  ...CORE_RUNTIME_BUILTINS,
  ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
]);

/** A call of a built-in without effects on script variables or time. */
function isPureBuiltinCall(expression: CallExpression): boolean {
  const callee = expression.callee;
  return callee.kind === "identifier" && PURE_BUILTINS.has(callee.name);
}

// Places -------------------------------------------------------------------------------------------------------------

function variablePlace(variable: Variable): Place {
  const name = variable.name;
  const type = variable.type;
  return {
    type,
    widening:
      variable.declaration === undefined ? undefined : { root: variable.declaration, path: [] },
    inferred: variable.declaration === undefined ? undefined : "variable",
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
  inferred = false,
  owner?: PlacePath,
): Place {
  const subject = name === null ? `This ${collection.kind}` : `'${name}'`;
  const element = resolved(collection.element);
  return {
    type: collection.element,
    widening: extendPath(owner, "[]"),
    inferred: inferred ? "part" : undefined,
    label: null,
    elementOf: name,
    subject:
      element.kind === "open"
        ? `${subject} holds a ${collection.kind}`
        : `${subject} holds ${typeName(element).replaceAll(" | ", " or ")} values (${typeName(collection)})${decidedAt(collection.element)}`,
    verb: "contain",
    fix: (value) => elementFix(name, collection, value, nullable),
  };
}

/** The place of a property inside a stored object literal, named after the place that keeps the object. */
function nestedPropertyPlace(type: StaticType, owner: Place, name: string): Place {
  const widening = extendPath(owner.widening, name);
  if (owner.label !== null)
    return propertyPlace(type, `${owner.label}.${name}`, `'${owner.label}.${name}'`, widening);
  const subject =
    owner.elementOf === undefined || owner.elementOf === null
      ? `Property '${name}'`
      : `Property '${name}' of the elements of '${owner.elementOf}'`;
  return propertyPlace(type, null, subject, widening);
}

function propertyPlace(
  type: StaticType,
  label: string | null,
  name: string,
  widening?: PlacePath,
): Place {
  return {
    type,
    widening,
    // No type can be written for a property.
    inferred: "part",
    label,
    subject: `${name} holds ${describeValue(type)}${decidedAt(type)}`,
    verb: "be set to",
    fix: (value, expression) => {
      const conversion = conversionFix(type, value, expression);
      return conversion ?? " Use a separate property for a value of another type.";
    },
  };
}

/** How a runtime type error names an assignment target, such as `'count'` or `property 'door.locked'`. */
function runtimePlace(target: AssignmentStatement["target"]): string {
  if (target.kind === "identifier") return `'${target.name}'`;
  const object = expressionLabel(target.object);
  if (target.kind === "indexExpression") return elementLabel(object, "list");
  return `property '${object === null ? "" : `${object}.`}${target.property.name}'`;
}

function elementLabel(collection: string | null, kind: "list" | "set"): string {
  return collection === null ? `an element of this ${kind}` : `an element of '${collection}'`;
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

/** The non-null part of a type, to tell whether it is known; a value that is only null stays null. */
function nonNullTypeForUse(type: StaticType): StaticType {
  const value = nonNullType(type);
  return value.kind === "never" ? resolved(type) : value;
}

/** The type of a property read on one known member type, or `undefined` when that type has no such property. */
function memberPropertyType(type: StaticType, name: string): StaticType | undefined {
  const value = resolved(type);
  switch (value.kind) {
    case "list":
    case "set":
      if (name === "length") return INTEGER_TYPE;
      return name === "first" || name === "last" || name === "random" ? value.element : undefined;
    case "object":
      return value.properties?.get(name) ?? UNKNOWN_TYPE;
    case "timer":
    case "media":
      return handlePropertyType(value.kind, name, "read");
    case "scalar":
      if (isScalar(value, "string")) return name === "length" ? INTEGER_TYPE : undefined;
      return temporalFieldType(value.name, name);
    case "range":
    case "null":
      return undefined;
    default:
      return UNKNOWN_TYPE;
  }
}

/** The result type of a method call on one known member type, or `undefined` when it has no such method. */
function memberMethodType(type: StaticType, method: string): StaticType | undefined {
  const value = resolved(type);
  if (value.kind === "timer" || value.kind === "media")
    return ["pause", "resume", "stop"].includes(method) ? NULL_TYPE : undefined;
  if (value.kind === "speaker" || value.kind === "unknown" || value.kind === "open")
    return UNKNOWN_TYPE;
  // Text operations (V30 §8).
  if (isScalar(value, "string")) {
    const member = TEXT_MEMBERS.get(method);
    return member?.parameters ? textResultType(member) : undefined;
  }
  if (value.kind === "scalar") return temporalMethodType(value.name, method);
  if (value.kind !== "list" && value.kind !== "set") return undefined;
  switch (method) {
    case "join":
      return value.kind === "list" ? STRING_TYPE : undefined;
    // A list reorders in place; a set keeps its insertion order (V30 §16).
    case "sort":
    case "shuffle":
      return value.kind === "list" ? NULL_TYPE : undefined;
    // A set operation builds a new collection of the receiver's kind.
    case "intersection":
    case "union":
    case "difference":
      return { kind: value.kind, element: copyType(value.element) };
    case "contains":
      return BOOLEAN_TYPE;
    // A conversion builds a new collection, so its elements decide their type apart from the original's.
    case "toSet":
      return value.kind === "list" ? { kind: "set", element: copyType(value.element) } : undefined;
    case "toList":
      return value.kind === "set" ? { kind: "list", element: copyType(value.element) } : undefined;
    case "add":
    case "remove":
    case "clear":
      return NULL_TYPE;
    case "removeAt":
    case "removeFirst":
    case "removeLast":
      // The removed element leaves the list, so its type is a copy for the place that keeps it.
      return value.kind === "list" ? copyType(value.element) : undefined;
    default:
      return undefined;
  }
}

/** The weekday names a date's `weekday` field is, from Monday (V30 §35). */
const WEEKDAY_TYPE = withValues(STRING_TYPE, [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

/** A date's ISO `weekdayNumber`: Monday is 1 and Sunday is 7. */
const WEEKDAY_NUMBER_TYPE = withValues(INTEGER_TYPE, [1, 2, 3, 4, 5, 6, 7]);

const TEMPORAL_KINDS: ReadonlySet<ScalarTypeName> = new Set([
  "date",
  "time",
  "datetime",
  "timestamp",
]);

/** Whether a value of this type is a date, time, date and time, or timestamp. */
function isTemporal(type: StaticType): boolean {
  const value = resolved(type);
  return value.kind === "scalar" && TEMPORAL_KINDS.has(value.name);
}

/** The type of a read-only field of a date or time value (V30 §35); a timestamp has none. */
function temporalFieldType(kind: ScalarTypeName, name: string): StaticType | undefined {
  if (kind === "date" || kind === "datetime") {
    if (name === "year" || name === "month" || name === "day") return INTEGER_TYPE;
    if (name === "weekday") return WEEKDAY_TYPE;
    if (name === "weekdayNumber") return WEEKDAY_NUMBER_TYPE;
  }
  if (
    (kind === "time" || kind === "datetime") &&
    ["hour", "minute", "second", "millisecond"].includes(name)
  )
    return INTEGER_TYPE;
  return undefined;
}

/** The result of a method of a date or time value, or `undefined` when it has none (V30 §35). */
function temporalMethodType(kind: ScalarTypeName, method: string): StaticType | undefined {
  if (!TEMPORAL_KINDS.has(kind)) return undefined;
  switch (method) {
    case "toISO":
      return STRING_TYPE;
    case "formatDate":
      return kind === "time" ? undefined : STRING_TYPE;
    case "formatTime":
      return kind === "date" ? undefined : STRING_TYPE;
    case "formatDateTime":
      return kind === "datetime" || kind === "timestamp" ? STRING_TYPE : undefined;
    case "toTimestamp":
      return kind === "datetime" ? TIMESTAMP_TYPE : undefined;
    case "toDateTime":
      return kind === "timestamp" ? DATETIME_TYPE : undefined;
    case "toSeconds":
    case "toMilliseconds":
      return kind === "timestamp" ? INTEGER_TYPE : undefined;
    default:
      return undefined;
  }
}

/** Property names whose write on a media handle first waits for the previous message's pacing. */
const MEDIA_PACED_PROPERTIES: ReadonlySet<string> = new Set(["position", "remaining", "volume"]);

/** Whether a value of this type may be one of the given handles, including a value of unknown type. */
function mayBe(type: StaticType, ...kinds: ("timer" | "media")[]): boolean {
  return members(type).some((member) => {
    const value = resolved(member);
    return (
      value.kind === "unknown" || value.kind === "open" || kinds.some((kind) => value.kind === kind)
    );
  });
}

/**
 * What assigning `name` on a value of one member type needs: the property's type, `null` when any value may be
 * stored, or why the property cannot be assigned.
 */
function assignableProperty(
  member: StaticType,
  name: string,
):
  { readonly type: StaticType | null } | { readonly problem: string; readonly receiver?: boolean } {
  if (member.kind === "timer" || member.kind === "media") {
    const type = handlePropertyType(member.kind, name, "assign");
    return type === undefined
      ? { problem: handleMemberMessage(member.kind, name, "assign") }
      : { type };
  }
  if (member.kind === "speaker" || member.kind === "unknown" || member.kind === "open")
    return { type: null };
  if (member.kind === "object" && member.properties === null) return { type: null };
  if (member.kind === "scalar" && temporalFieldType(member.name, name) !== undefined)
    return {
      problem: `Property '${name}' of ${describeValue(member)} cannot be assigned; date and time values do not change.`,
    };
  // A problem with the receiver itself points at the receiver.
  if (["scalar", "list", "set", "range", "null"].includes(member.kind))
    return {
      problem: isScalar(member, "string")
        ? `Text cannot be changed, so '${name}' cannot be assigned. Assign a new text to the variable instead.`
        : `Only objects, speakers, and timer and media handles have properties to assign, but this is ${describeValue(member)}.`,
      receiver: true,
    };
  const type = member.kind === "object" ? member.properties?.get(name) : undefined;
  return type === undefined
    ? { problem: `${capitalize(describeValue(member))} has no property '${name}'.` }
    : { type };
}

function isList(type: StaticType): boolean {
  return resolved(type).kind === "list";
}

/** Whether a receiver may be a set. */
function isSetReceiver(type: StaticType): boolean {
  return members(nonNullType(type)).some((member) => resolved(member).kind === "set");
}

function isSetElement(type: StaticType): boolean {
  const value = resolved(type);
  return (
    value.kind === "null" ||
    value.kind === "unknown" ||
    (value.kind === "scalar" && value.name !== "duration")
  );
}

/**
 * Every name a function declaration uses as a value or an assignment target, also where a local variable of the same
 * name hides it, which may only make the function wait longer than it needs to. Declared names, property names, and
 * argument names are not uses. The tree is walked with an explicit stack.
 */
/** Syntax tree fields that hold a declared, property, or argument name, or a source position, not a use. */
const NOT_USES: ReadonlySet<string> = new Set(["span", "name", "property", "variable"]);

function namesIn(root: FunctionDeclaration): ReadonlySet<string> {
  const names = new Set<string>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    if (
      "kind" in node &&
      node.kind === "identifier" &&
      "name" in node &&
      typeof node.name === "string"
    )
      names.add(node.name);
    for (const [key, value] of Object.entries(node)) if (!NOT_USES.has(key)) pending.push(value);
  }
  return names;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

/** The name of the variable a declaration declares. */
function declarationName(declaration: Declaration): string {
  return declaration.kind === "forStatement" ? declaration.variable.name : declaration.name.name;
}

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

/**
 * The type of a choice whose button values the source shows: one type per family of values, such as text or numbers,
 * restricted to those values, and `null` when a button returns it.
 */
function restrictedChoice(
  types: readonly StaticType[],
  values: readonly (ScalarValue | null)[],
): StaticType {
  const families = new Map<string, { name: ScalarTypeName; values: ScalarValue[] }>();
  const parts: StaticType[] = [];
  for (const [index, type] of types.entries()) {
    const value = resolved(type);
    const literal = values[index];
    if (value.kind !== "scalar" || literal === null || literal === undefined) {
      parts.push(type);
      continue;
    }
    const key = value.name === "integer" ? "number" : value.name;
    const family = families.get(key) ?? { name: value.name, values: [] };
    if (family.name !== value.name) family.name = "number";
    family.values.push(literal);
    families.set(key, family);
  }
  for (const family of families.values())
    parts.push(withValues({ kind: "scalar", name: family.name }, family.values));
  return union(parts);
}

/**
 * Whether the values a button may return are of more than one type, such as text and numbers. Other kinds of values are
 * not button values and are reported as such.
 */
function mixesFamilies(type: StaticType): boolean {
  const families = new Set<string>();
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (value.kind === "scalar") families.add(value.name === "integer" ? "number" : value.name);
  }
  return families.size > 1;
}

/** A numeric value with `-` before it: the values a `choose` restricted it to change sign too. */
function negatedValues(type: StaticType, operator: string): StaticType {
  if (operator !== "-" || type.kind !== "scalar" || type.values === undefined) return type;
  return withValues(
    type,
    type.values.map((value) => (typeof value === "number" ? -value : value)),
  );
}

/** List properties that read one of its elements. */
const LIST_ELEMENT_READS: ReadonlySet<string> = new Set(["first", "last", "random"]);

/** For a place whose type cannot be declared, such as a property: a union type has no written form there yet. */
const ONE_TYPE_FIX = "give every button a value of one type";

/** The value a button returns when the source shows it: a literal, or a choice object's literal value or text. */
function buttonLiteral(entry: Expression): ScalarValue | null | undefined {
  const node = unwrap(entry);
  if (node.kind !== "objectLiteral") return literalValue(node);
  const property =
    node.properties.find((candidate) => candidate.name.name === "value") ??
    node.properties.find((candidate) => candidate.name.name === "text");
  return property === undefined ? undefined : literalValue(property.value);
}

/** The text, number, true, false, or null that an expression certainly is, or `undefined`. */
function literalValue(expression: Expression): ScalarValue | null | undefined {
  const known = staticChoiceValue(expression)?.value;
  // A duration is compared by its length, so it stands for its milliseconds in a duration type.
  return known !== null && typeof known === "object" ? known.milliseconds : known;
}

/** The value a compared expression certainly is, such as `"Open"` or `1 s`, or `undefined`. */
function comparedLiteral(expression: Expression): readonly PossibleValue[] | undefined {
  const known = staticChoiceValue(expression);
  if (known === undefined) return undefined;
  const value = known.value;
  return [
    value !== null && typeof value === "object"
      ? { value: value.milliseconds, duration: true }
      : { value, duration: false },
  ];
}

/** Literal values as an author writes them, as in `"spank" or "lines"`. */
function describeLiterals(values: readonly PossibleValue[]): string {
  const written = values.map(({ value, duration }) =>
    typeof value === "string"
      ? JSON.stringify(value)
      : duration && typeof value === "number"
        ? formatDuration(value)
        : String(value),
  );
  return written.length <= 1
    ? (written[0] ?? "")
    : `${written.slice(0, -1).join(", ")} or ${written.at(-1)!}`;
}

/** Whether `${...}` and text fields show a value of this member type as text. */
function isShowable(member: StaticType): boolean {
  return !UNSHOWABLE_KINDS.has(resolved(member).kind);
}

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

/** A slot already decided by its first value at `at`, so a later mismatch can name that line. */
function decidedSlot(type: StaticType, at: SourceSpan): StaticType {
  // A place still undecided, such as one that so far took only null, is decided by its first other value instead.
  if (members(type).some((member) => member.kind === "open")) return type;
  const slot = openType();
  slot.resolved = type;
  slot.resolvedAt = at;
  return slot;
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
  if (["<", "<=", ">", ">="].includes(operator)) {
    const temporal = isTemporal(left!) ? left! : isTemporal(right!) ? right! : undefined;
    if (temporal !== undefined)
      return `'${operator}' compares ${describeValue(temporal)} only with another ${temporalNoun(temporal)}, not with ${describeValue(temporal === left ? right! : left!)}.${expression.kind === "binaryExpression" ? temporalPairFix(expression, operator, left!, right!) : ""}`;
    return `'${operator}' compares two numbers, two texts, or two durations, but these are ${describeValue(left!)} and ${describeValue(right!)}.`;
  }
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
  if (isScalar(left!, "time") || isScalar(right!, "time"))
    return `'${operator}' cannot combine ${describeValue(left!)} and ${describeValue(right!)}: arithmetic on a time is not available. Combine it with a date first, as in 'toDateTime(date, time)'.`;
  if (expression.kind === "binaryExpression" && (operator === "+" || operator === "-")) {
    // A timestamp or a date and time moves by a duration written after it.
    if (isScalar(left!, "timestamp", "datetime")) {
      const subject = describeValue(left!);
      const added =
        operator === "+"
          ? `'+' adds only a duration to ${subject}`
          : `'-' subtracts only a duration or another ${temporalNoun(left!)} from ${subject}`;
      const fix = isNumeric(right!)
        ? ` ${unitFix(expression.right)}`
        : operator === "-"
          ? temporalPairFix(expression, operator, left!, right!)
          : "";
      return `${added}, not ${describeValue(right!)}.${fix}`;
    }
    if (operator === "+" && duration(left!) && isScalar(right!, "timestamp", "datetime"))
      return `'+' cannot add ${describeValue(right!)} to a duration. Write it first, as in '${expressionLabel(expression.right) ?? "value"} + 1 h'.`;
  }
  return `'${operator}' cannot combine ${describeValue(left!)} and ${describeValue(right!)}.`;
}

/** What a date or time value is called after "another", such as `date and time`. */
function temporalNoun(type: StaticType): string {
  return describeValue(type).replace(/^an? /u, "");
}

/**
 * How to compare or subtract a date and time and a value of another kind: convert one of them. A date and time and a
 * timestamp convert through the player's zone; a date or a time is compared with that part of a date and time.
 */
function temporalPairFix(
  expression: Extract<Expression, { kind: "binaryExpression" }>,
  operator: string,
  left: StaticType,
  right: StaticType,
): string {
  const local = isScalar(left, "datetime") ? 0 : isScalar(right, "datetime") ? 1 : -1;
  if (local < 0) return "";
  const other = local === 0 ? right : left;
  const label = expressionLabel(local === 0 ? expression.left : expression.right) ?? "value";
  if (isScalar(other, "timestamp")) return ` Convert one first, as in '${label}.toTimestamp()'.`;
  if (operator === "-") return "";
  if (isScalar(other, "date")) return ` Compare its date, as in 'toDate(${label})'.`;
  if (isScalar(other, "time")) return ` Compare its time, as in 'toTime(${label})'.`;
  return "";
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
  // A timestamp or a date and time moves by a duration as well.
  if (isScalar(operand, "duration", "timestamp", "datetime")) {
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
  // Date and time values are written as ISO text and converted.
  const conversion = Object.entries(TEMPORAL_CONVERSIONS).find(([, { result }]) =>
    isScalar(kept, result),
  );
  if (conversion !== undefined && isScalar(value, "string"))
    return ` Convert the text with ${conversion[0]}(...).`;
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

/** For a union value stored in a narrower place: the test that makes the store safe (ADR 0021 rule 3.5). */
function checkFirstFix(
  target: StaticType,
  value: StaticType,
  expression: Expression,
): string | undefined {
  const all = members(value);
  const passing = all.filter((member) => isAssignable(target, member));
  if (all.length < 2 || passing.length === 0) return undefined;
  // A value that may be null is checked with `!= null` (owner decision on #504 Q1). Only a plain variable narrows, so
  // a property or element is first kept in a variable.
  const node = unwrap(expression);
  const label = node.kind === "identifier" ? node.name : null;
  const test = all.every((member) => passing.includes(member) || member.kind === "null")
    ? "!= null"
    : `is ${typeName(union(passing))}`;
  return label === null
    ? ` Keep it in a variable and check it first, as in: if value ${test} { ... }`
    : ` Check it first: if ${label} ${test} { ... }`;
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
  const both = union([target, value]);
  return isAnnotatable(both)
    ? ` To allow both, declare it as 'let ${name}: ${typeName(both)} = ...'.`
    : " Use a separate variable for a value of another type.";
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
  const conversion = conversionFix(target, value, expression);
  if (conversion !== undefined) return conversion;
  const both = union([target, value]);
  if (!isAnnotatable(both)) return " Use a value of the parameter's type.";
  const declaration =
    defaultValue === undefined
      ? `${name}: ${typeName(both)}`
      : `${name}: ${typeName(both)} = ${sourceText(defaultValue) ?? "..."}`;
  return ` To allow both, declare the parameter as '${declaration}'.`;
}

function sourceText(expression: Expression): string | null {
  const literal = unwrap(expression);
  if (literal.kind === "numberLiteral") return literal.raw;
  if (literal.kind === "booleanLiteral") return String(literal.value);
  return null;
}

/** How to let a function return values of two types: declare a union result type. */
function returnUnionFix(
  declaration: FunctionDeclaration,
  first: StaticType,
  other: StaticType,
): string {
  const both = union([first, other]);
  if (!isAnnotatable(both))
    return " A function returns one type; use a separate function for values of another type.";
  const parameters = declaration.parameters.length === 0 ? "" : "(...)";
  return ` To return both, declare the result type, as in 'function ${declaration.name.name}${parameters}: ${typeName(both)}'.`;
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
  const both: StaticType = { kind: collection.kind, element: union([collection.element, value]) };
  if (variable !== null && isAnnotatable(both))
    return ` To allow both, declare it as 'let ${variable}: ${typeName(both)}${nullable ? "?" : ""} = ...'.`;
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

/** Receivers whose members `memberProblems` checks: text, values without members, and values the compiler cannot know. */
const MEMBER_CHECKED_KINDS: ReadonlySet<StaticType["kind"]> = new Set([
  "scalar",
  "null",
  "range",
  "unknown",
  "open",
]);

/** The result type of a text member: a new value, so a `string[]` from `split` decides nothing elsewhere. */
function textResultType(member: TextMember): StaticType {
  return member.result === "string[]"
    ? { kind: "list", element: STRING_TYPE }
    : scalarType(member.result);
}

function scalarType(name: "string" | "integer" | "number" | "boolean"): StaticType {
  return { kind: "scalar", name };
}
