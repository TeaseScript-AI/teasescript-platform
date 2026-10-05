import type {
  AssignmentStatement,
  Block,
  CallArgument,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionParameter,
  GlobalStatement,
  Identifier,
  InteractionExpression,
  LetStatement,
  MediaParts,
  Program,
  ScalarTypeName,
  ShowButtonParts,
  ShowPermanentButtonParts,
  SpeakerDeclaration,
  SwitchTypeTest,
  Statement,
  TagQueryExpression,
  TagQueryStep,
  TimerParts,
  TransferTarget,
  TypeAnnotation,
} from "./ast.js";
import {
  globMatches,
  isPathGlob,
  MAIN_FILE_PATH,
  packageGlobProblem,
  packagePathProblem,
} from "./project-paths.js";
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
import type { PlanImage, PlanTag, TypeCheckPlan } from "./plan/model.js";
import { isTakePhotoCall } from "./capture-call.js";
import { evaluateTagSteps, passesTagList } from "./tag-query.js";
import { addTag, normalizeTagName, readTagText, type Tag } from "./tags.js";
import { CONVERSION_RESULTS, isTemporalConversionResult } from "./conversions.js";
import {
  builtinCallProblems,
  builtinShapeProblems,
  COLLECTION_METHODS,
  collectionMethodProblems,
  expressionLabel,
  memberProblems,
  type OperationProblem,
} from "./operation-checks.js";
import { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "./protected-names.js";
import {
  compareDurationParts,
  divideDurationParts,
  durationFamily,
  durationLiteralParts,
  durationParts,
  durationRatio,
  formatDuration,
  isExactDuration,
  scaleDurationParts,
  type DurationParts,
} from "./duration.js";
import {
  knownOperands,
  knownStep,
  staticChoiceValue,
  staticNumber,
  staticVisibleText,
  type StaticScalar,
} from "./static-evaluation.js";
import { MAX_INTERACTION_OPTION_ENTRIES } from "./interaction-limits.js";
import { caseValueText, impossibleCaseMessage, literalRange } from "./switch-cases.js";
import { createSourceSpan, type SourceSpan } from "./source.js";
import { TEXT_MEMBERS, type TextMember } from "./text-operations.js";
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
  isCollection,
  type CollectionType,
  isKnown,
  isNullable,
  isNumeric,
  isScalar,
  joinTypes,
  mayEqualAny,
  plainType,
  possibleValues,
  type PossibleValue,
  type ScalarValue,
  TypeJoin,
  members,
  type PropertyTable,
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
  SCRIPT_TYPE,
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
import { runsOnItsOwn, sessionDeclarations } from "./project-globals.js";

export interface TypeCheckOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
  /** The package images that tag queries search, when the compilation was given them. */
  readonly imageCatalog?: readonly PlanImage[];
  /** Whether some file of the project takes photos with tags, which join the catalog at runtime. */
  readonly capturesTaggedPhotos?: boolean;
  /**
   * The project's files with the tags of their headers, which script tag queries match; `null` tags for a file of
   * declarations only, which is never picked or listed.
   */
  readonly scriptCatalog?: readonly {
    readonly path: string;
    readonly tags: readonly PlanTag[] | null;
  }[];
}

export interface TypeCheckResult {
  /** The diagnostics of each file, in project order. */
  readonly diagnostics: readonly (readonly Diagnostic[])[];
  /** The runtime checks of values the compiler cannot know, by the source of the instruction that stores them. */
  readonly runtimeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>;
  /** Whether a file of the project has an `exit` that execution can reach; a project needs one (ADR 0022). */
  readonly reachesExit: boolean;
  /** Which statements run, for the checks that follow this flow. */
  readonly flow: StatementFlow;
}

/** The statements that never run, and the top-level statements that run and after which execution continues. */
export interface StatementFlow {
  readonly unreachable: ReadonlySet<Statement>;
  readonly continuing: ReadonlySet<Statement>;
}

/**
 * Where a value is stored in a place of known type: a `let` or assignment, the start value of a `global`, a list or
 * set `add` call, the default of a dict `get` call, an argument of an author function, a parameter default, or a
 * `return`.
 */
export type RuntimeCheckSite =
  | LetStatement
  | GlobalStatement
  | AssignmentStatement
  | CallExpression
  | CallArgument
  | FunctionParameter
  | Extract<Statement, { kind: "returnStatement" }>;

const typeCode = {
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
  emptyTagQuery: "TST002",
  invalidCaptureTag: "TST005",
  invalidTagQueryFrom: "TST006",
  randomStartValue: "TSV055",
  closedLoop: "TSV058",
  invalidCameraPlacement: "TSV059",
} as const;

/**
 * Checks that every variable, list or set element, object property, function parameter, and function result keeps one
 * type, and that operations receive values they support (ADR 0021). It runs after name validation succeeded, so every
 * name resolves; a value it cannot know has the type `unknown` and is never rejected. The files of a project, in
 * project order, are checked together, because globals, global functions, and speakers belong to all of them.
 * `onFile` hears of each file whose source the check enters.
 */
export function checkTypes(
  files: readonly { readonly path: string; readonly program: Program }[],
  options: TypeCheckOptions = {},
  onFile: (file: number) => void = () => {},
): TypeCheckResult {
  const programs = files.map((file) => file.program);
  const lines = lineNamer(files);
  // An integer variable is a number when one of its assignments can store a non-whole number, also an assignment
  // after its uses (rule 1.2). A check that finds a new one starts again with that variable declared as a number, so
  // the last check, which finds none, sees every variable with its final type and alone reports.
  const widened: Widened = new Map();
  for (;;) {
    const checker = new TypeChecker(options, widened, programs.length, onFile, lines);
    checker.check(programs);
    if (!checker.widenedMore) {
      const closedLoops = closedLoopWarnings(programs, checker.unreachable);
      return Object.freeze({
        diagnostics: Object.freeze(
          checker.fileDiagnostics.map((diagnostics, file) =>
            Object.freeze([...diagnostics, ...closedLoops[file]!]),
          ),
        ),
        runtimeChecks: checker.runtimeChecks(),
        reachesExit: checker.reachesExit,
        flow: Object.freeze({ unreachable: checker.unreachable, continuing: checker.continuing }),
      });
    }
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
  /** The file the function is written in. */
  readonly file: number;
  /** The names its parameters and body see: those of its file, or for a global function the project's alone. */
  readonly scope: Scope;
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
    /** The file the call is written in. */
    readonly file: number;
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
  /** For the elements of a list stored at once, as by `addAll`: a test checks that whole list. */
  readonly listed?: boolean;
  /** For example `'score' holds a whole number (integer)` or `'scores' holds integer values (integer[])`. */
  readonly subject: string;
  /** What the value would do: `start as`, `be set to`, `contain`, `take`, or `return`. */
  readonly verb: string;
  /** The suggestion appended to the message, given the rejected value. */
  readonly fix: (value: StaticType, expression: Expression | null) => string;
}

class TypeChecker {
  /** The diagnostics of each file of the project. */
  readonly fileDiagnostics: Diagnostic[][];

  /** The file whose source is being checked. */
  #file = 0;

  readonly #builtins: ReadonlySet<string>;

  /** The tags of each package image, by name; `null` when the compilation was not given the images. */
  readonly #imageTags: readonly ReadonlyMap<string, number | null>[] | null;

  readonly #capturesTaggedPhotos: boolean;

  /** The project's files and their tags by name, `null` for declarations only; `null` when not given. */
  readonly #scriptCatalog:
    | readonly { readonly path: string; readonly tags: ReadonlyMap<string, number | null> | null }[]
    | null;

  /** The project's names: host globals, globals, speakers, and global functions. */
  readonly #project = new Scope(null);

  /** The top-level names of the file being checked, under the project's names. */
  #root = new Scope(this.#project);

  /** The scope the code being checked starts under: its file's names, or the project's alone (see `FunctionType`). */
  #outer = this.#root;

  /**
   * The names of the file's top-level `let` variables, which function bodies may use before they are declared.
   */
  #scriptVariables = new Set<string>();
  /** Whether the script's top-level statements are checked, so every script variable has its type. */
  #scriptChecked = false;
  /** The names each function's parameters and body mention, found when first needed. */
  readonly #namesUsed = new Map<FunctionType, ReadonlySet<string>>();

  /** Timer and media blocks to check after their file's functions, with the scope and file they belong to. */
  readonly #handlers: {
    readonly block: Block;
    readonly selfHandle: string | null;
    readonly scope: Scope;
    readonly file: number;
  }[] = [];

  #function: FunctionContext | null = null;

  readonly #types = new Map<Expression, StaticType>();

  /** Numbers and durations known at compile time, folded once per expression (see `#known`). */
  readonly #knownValues = new Map<Expression, StaticScalar | undefined>();

  /** The checked expressions whose kept type is still the type of the place they read. */
  readonly #placeReads = new Set<Expression>();

  /** The flows at the reachable `break` statements of each enclosing loop, and whether a `continue` is reachable. */
  readonly #loops: { readonly start: FlowState; breaks: Changes[]; continued: boolean }[] = [];

  /** The narrowed types at the current point of the checked code. */
  #flow = new Flow();

  /** What functions, blocks, and loops may change, collected before checking: for the file, and for every loop. */
  #effects: Pick<ProgramEffects, "shared" | "loops"> = { shared: new Set(), loops: new Map() };

  /** The globals that a function or a timer or media block of any file assigns. */
  #sharedGlobals: ReadonlySet<string> = new Set();

  /** Whether the statement being checked can run; a `break` after a `return` does not end its loop. */
  #reachable = true;

  /** Whether a reachable `exit` was checked. */
  reachesExit = false;

  /** The statements that never run, by the flow this check follows. */
  readonly unreachable = new Set<Statement>();

  /** The top-level statements that run and after which execution continues. */
  readonly continuing = new Set<Statement>();

  #rootStatements: readonly Statement[] | null = null;

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

  /** Variables with a widening recorded in this check since they were last widened again (see {@link #rewiden}). */
  readonly #unappliedWidening = new Set<Declaration>();

  /**
   * For each integer place, by its variable and its path there, the integer places that store its value, with where:
   * when it widens, they widen too, without one more check per step of a chain.
   */
  readonly #followers = new Map<Declaration, Map<string, Follower[]>>();

  /** The variable each declaration created most recently, whose type later widenings change. */
  readonly #declared = new Map<Declaration, Variable>();

  /** One origin for each element or property inside a variable, so equal parts are one origin. */
  readonly #parts = new Map<Declaration, Map<string, PartOrigin>>();

  public constructor(
    options: TypeCheckOptions,
    widened: Widened,
    files: number,
    private readonly onFile: (file: number) => void,
    private readonly lines: LineNamer,
  ) {
    this.fileDiagnostics = Array.from({ length: files }, () => []);
    this.#widened = widened;
    this.#capturesTaggedPhotos = options.capturesTaggedPhotos ?? false;
    this.#scriptCatalog =
      options.scriptCatalog?.map((file) => ({
        path: file.path,
        tags: file.tags === null ? null : new Map(file.tags.map((tag) => [tag.name, tag.value])),
      })) ?? null;
    this.#imageTags =
      options.imageCatalog?.map(
        (image) => new Map(image.tags.map((tag) => [tag.name, tag.value])),
      ) ?? null;
    this.#builtins = new Set([
      ...CORE_RUNTIME_BUILTINS,
      ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
      ...(options.builtins ?? []),
    ]);
    // Host globals have no static type and cannot be assigned, but a test may narrow them.
    for (const name of options.globals ?? [])
      this.#project.declare(name, {
        kind: "variable",
        variable: { name, type: UNKNOWN_TYPE, shared: false },
      });
  }

  /** The diagnostics of the file being checked. */
  get diagnostics(): Diagnostic[] {
    return this.fileDiagnostics[this.#file]!;
  }

  /** `line 3`, or for a line of another file `line 3 of helpers.tease`. */
  readonly #line: (span: SourceSpan) => string = (span) => this.lines(span, this.#file);

  /** How a message names a line and the declaration a fix suggests. */
  readonly #text: PlaceText = { line: this.#line, keyword: (name) => this.#keyword(name) };

  /** The keyword that declares a variable of this name: `global` for a global, otherwise `let`. */
  #keyword(name: string | null): "global" | "let" {
    return name !== null && this.#project.resolve(name)?.kind === "variable" ? "global" : "let";
  }

  /** Continues in the source of `file`, returning the file to come back to. */
  #enterFile(file: number): number {
    const previous = this.#file;
    this.#file = file;
    this.onFile(file);
    return previous;
  }

  /**
   * Checks the project: the start values of globals and speakers in the order a session sets them up, then each file,
   * `main.tease` first, as a single script (rule 6).
   */
  public check(programs: readonly Program[]): void {
    const effects = programs.map(programEffects);
    const loops = new Map(effects.flatMap((fileEffects) => [...fileEffects.loops]));
    const sharedGlobals = new Set<string>();
    for (const fileEffects of effects)
      for (const name of fileEffects.shared) sharedGlobals.add(name);
    // While a `call` runs, any file's top level may run and assign globals (ADR 0022 §5, §6).
    if (effects.some((fileEffects) => fileEffects.callsFiles))
      for (const fileEffects of effects)
        for (const name of fileEffects.rootAssigned) sharedGlobals.add(name);
    this.#sharedGlobals = sharedGlobals;
    const functionsByFile = programs.map(() => new Map<FunctionDeclaration, FunctionType>());
    for (const [file, program] of programs.entries())
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration" && statement.global)
          functionsByFile[file]!.set(
            statement,
            this.#declareFunction(statement, file, this.#project),
          );
    this.#effects = { shared: new Set(), loops };
    // Start values run one after another with nothing between them, so what one stores is known to the next.
    this.#flow = new Flow();
    for (const { file, declaration } of sessionDeclarations(programs)) {
      this.#enterFile(file);
      runCompileTask(this.#startValueTask(declaration));
      this.#reportMixedLiterals();
    }
    // main.tease runs right after the start values, so it starts with what they stored, unless a transfer enters it
    // again later; other files start afresh.
    const startupFlow = effects.some((fileEffects) => fileEffects.entersMain)
      ? new Flow()
      : this.#flow;
    for (const [file, program] of programs.entries()) {
      this.#enterFile(file);
      this.#effects = { shared: effects[file]!.shared, loops };
      this.#root = new Scope(this.#project);
      this.#outer = this.#root;
      this.#scriptVariables = new Set(
        program.statements.flatMap((statement) =>
          statement.kind === "letStatement" ? [statement.name.name] : [],
        ),
      );
      this.#scriptChecked = false;
      this.#flow = file === 0 ? startupFlow : new Flow();
      const functions = functionsByFile[file]!;
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration" && !statement.global)
          functions.set(statement, this.#declareFunction(statement, file, this.#root));
      const rootStatements = program.statements.filter(
        (statement) => statement.kind !== "functionDeclaration",
      );
      this.#rootStatements = rootStatements;
      const continues = runCompileTask(this.#statementsTask(rootStatements, this.#root));
      // A file of declarations only runs nothing on its own, so it has no way to its end.
      if (continues && rootStatements.some(runsOnItsOwn)) {
        const last = rootStatements.at(-1)!;
        const call = last.kind === "expressionStatement" ? unwrapGrouping(last.expression) : null;
        // A call counts as returning, also of a function that always exits.
        this.#report(
          "TSV052",
          call?.kind === "callExpression" && call.callee.kind === "identifier"
            ? `This path reaches the end of the file after ${call.callee.name}(). Even if ${call.callee.name} ends the session, add exit (or end) here so the ending is explicit.`
            : "The script can run past the end of this file. Add exit where the session should finish, or end to return to the file that called this one.",
          last.span,
        );
      }
      // Every script variable has its type now, so every function body is checked, also one that waited for one.
      this.#scriptChecked = true;
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration")
          runCompileTask(this.#functionResultTask(functions.get(statement)!));
      for (let index = 0; index < this.#handlers.length; index += 1) {
        const handler = this.#handlers[index]!;
        this.#enterFile(handler.file);
        const scope = new Scope(handler.scope);
        if (handler.selfHandle !== null)
          scope.declare(handler.selfHandle, {
            kind: "variable",
            variable: { name: handler.selfHandle, type: { kind: "media" }, shared: false },
          });
        this.#function = null;
        this.#outer = handler.scope;
        // A block does not inherit narrowed facts from the code around it (rule 5.5).
        this.#flow = new Flow();
        runCompileTask(this.#statementsTask(handler.block.statements, scope));
      }
      this.#handlers.length = 0;
    }
  }

  #declareFunction(declaration: FunctionDeclaration, file: number, scope: Scope): FunctionType {
    const fn: FunctionType = {
      declaration,
      file,
      scope,
      parameters: null,
      accepted: null,
      result: null,
      checking: false,
      pending: [],
    };
    scope.declare(declaration.name.name, { kind: "function", fn });
    return fn;
  }

  /**
   * Checks the start value of a global or the properties of a speaker. It is set up before the story runs, so it uses
   * only the project's names (ADR 0022 §6); its type is the global's type by the `let` rules.
   */
  *#startValueTask(declaration: GlobalStatement | SpeakerDeclaration): CompileTask<void> {
    this.#function = null;
    this.#outer = this.#project;
    this.#reachable = true;
    if (declaration.kind === "globalStatement") {
      yield* compileChild(this.#letTask(declaration, this.#project));
      this.#rejectRandomSelection(declaration.initial);
      return;
    }
    this.#project.declare(declaration.name.name, { kind: "speaker" });
    for (const property of declaration.properties) {
      const type = yield* compileChild(this.#expressionTask(property.value, this.#project));
      this.#checkSpeakerProperty(property.name.name, property.value, type);
      this.#rejectRandomSelection(property.value);
    }
  }

  /**
   * Reports a start value that would select a random element: a list shown in `${...}`, or `.random`. A start value is
   * set up before the story runs and uses no random numbers (ADR 0022 §6); the runtime rejects a value of unknown type.
   */
  #rejectRandomSelection(value: Expression): void {
    const work = [value];
    while (work.length > 0) {
      const expression = work.pop()!;
      if (
        expression.kind === "propertyAccessExpression" &&
        expression.property.name === "random" &&
        this.#mayBe(expression.object, isListOrSet)
      )
        this.#report(
          typeCode.randomStartValue,
          "A start value cannot select a random element with '.random': it is set up at the start of the session, before the story runs. Pick the element in the story instead.",
          expression.span,
        );
      if (expression.kind === "stringLiteral")
        for (const part of expression.parts)
          if (part.kind === "stringInterpolation" && this.#mayBe(part.expression, isList))
            this.#report(
              typeCode.randomStartValue,
              "A start value cannot show a list in '${...}', which selects a random element: it is set up at the start of the session, before the story runs. Show one element, as in '${items[0]}'.",
              part.expression.span,
            );
      for (const child of expressionChildren(expression)) work.push(child);
    }
  }

  /** Whether a checked expression is known to possibly hold a value of a kind. */
  #mayBe(expression: Expression, kind: (type: StaticType) => boolean): boolean {
    const type = this.#types.get(expression);
    return (
      type !== undefined && members(nonNullType(type)).some((member) => kind(resolved(member)))
    );
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
      // A goto can reach a label even when the statements before it never continue.
      if (statement.kind === "labelStatement") continues = true;
      this.#reachable = reachable && continues;
      if (!this.#reachable) this.unreachable.add(statement);
      if (!(yield* compileChild(this.#statementTask(statement, scope)))) continues = false;
      else if (this.#reachable && statements === this.#rootStatements)
        this.continuing.add(statement);
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
        // Its properties are start values, checked before the files.
        return true;
      case "globalStatement":
        // The start value is checked before the files; with `default:`, the declaration assigns where it stands.
        if (statement.assignment !== null)
          yield* compileChild(this.#assignmentTask(statement.assignment, scope));
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
      case "showPermanentButtonStatement":
        yield* compileChild(this.#permanentButtonTask(statement, scope));
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
      case "showCameraStatement":
      case "hideCameraStatement":
        this.#suspend();
        return true;
      case "saveStatement": {
        const value = yield* compileChild(this.#expressionTask(statement.value, scope));
        if (
          containsType(value, (part) =>
            ["speaker", "timer", "media", "camera", "permanentButton"].includes(part.kind),
          )
        )
          this.#report(
            typeCode.invalidOperand,
            `Speakers, camera views, permanent buttons, and timer or media handles cannot be saved, but this is ${describeValue(value)}.`,
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
        // The type cases so far, which take a literal value of their type even when the switched type is not known.
        const typeCases: { readonly typeTest: SwitchTypeTest; readonly test: StaticType }[] = [];
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
            typeCases.push({ typeTest: switchCase.typeTest, test });
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
              const earlier = takingTypeCase(typeCases, value, valueType);
              if (earlier !== undefined) {
                const { typeTest, test } = earlier;
                this.diagnostics.push(
                  createDiagnostic(
                    DiagnosticSeverity.Warning,
                    typeCode.constantTest,
                    `'case is ${typeTest.negated ? "not " : ""}${typeName(test)}' on line ${typeTest.span.start.line + 1} already takes ${caseValueText(value) ?? "this value"}, so this case never matches.`,
                    value.span,
                  ),
                );
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
            // A value case keeps what the cases above left. `null` narrows like `x == null`: `case null` knows `null`, and
            // a case that lists `null`, as in `case null, 0`, takes it from every later case.
            reached = matchable;
            const nulls = switchCase.values.filter((value) => unwrap(value).kind === "nullLiteral");
            taken =
              nulls.length === switchCase.values.length
                ? narrowTo(remaining, NULL_TYPE)
                : remaining;
            if (nulls.length > 0) remaining = excludeType(remaining, NULL_TYPE);
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
        const times = staticNumber(statement.count);
        const ends = yield* compileChild(
          this.#loopBodyTask(statement.body, scope, null, times === undefined || times >= 1),
        );
        // A loop that certainly runs once ends normally only when its body or a `break` does.
        return times === undefined || times < 1 || ends;
      }
      case "forStatement": {
        const iterable = yield* compileChild(this.#expressionTask(statement.iterable, scope));
        // A loop over a dict goes through its keys.
        const element = elementType(iterable, true);
        this.#reportUnless(
          iterable,
          (member) => elementType(member, true) !== undefined,
          statement.iterable,
          "A for-loop goes through a list, a set, a dict, or a range",
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
        const ends = yield* compileChild(
          this.#loopBodyTask(statement.body, scope, variable, !isEmptyLiteral(statement.iterable)),
        );
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
        if (this.#reachable) this.reachesExit = true;
        return false;
      case "endStatement":
        return false;
      case "gotoStatement":
        yield* compileChild(this.#targetTask(statement.target, "goto", scope));
        return false;
      case "callFileStatement":
        yield* compileChild(this.#targetTask(statement.target, "call", scope));
        // The called file runs until its end, like any suspension.
        this.#suspend();
        return true;
      case "fallbackStatement":
        if (statement.target !== null)
          yield* compileChild(this.#targetTask(statement.target, "fallback", scope));
        return true;
      case "labelStatement":
        // A goto from anywhere in the file may arrive here, so nothing narrowed before the label still holds.
        this.#flow = new Flow();
        return true;
      case "returnStatement":
        yield* compileChild(this.#returnTask(statement, scope));
        return false;
      case "functionDeclaration":
        return true;
    }
  }

  /** A computed target, such as `goto (next)`, is a script reference; plain text is not a jump target (V30 §29). */
  *#targetTask(
    target: TransferTarget,
    keyword: "goto" | "call" | "fallback",
    scope: Scope,
  ): CompileTask<void> {
    if (target.kind !== "scriptTarget") return;
    const type = yield* compileChild(this.#expressionTask(target.expression, scope));
    this.#reportUnless(
      type,
      (member) => isScalar(member, "script"),
      target.expression,
      `${keyword} needs a script reference here`,
      () =>
        members(type).some((member) => isScalar(member, "string"))
          ? ` Plain text is not a jump target: turn a path into one with script(...), as in ${keyword} script("rooms/hall.tease").`
          : ` Make one with script(...), as in ${keyword} script("rooms/hall.tease").`,
    );
  }

  /**
   * A block that runs when a condition decides so, or an `else if`. A block the condition never selects is still
   * checked, but nothing in it, such as a `break`, can be reached.
   */
  *#pathTask(block: Block | Statement, scope: Scope, reached: boolean): CompileTask<boolean> {
    const reachable = this.#reachable;
    if (!reached) this.#reachable = false;
    // An `else if` is a statement outside any statement list; the flow records it like one.
    if (block.kind !== "block" && !this.#reachable) this.unreachable.add(block);
    const continues =
      block.kind === "block"
        ? yield* compileChild(this.#blockTask(block, scope))
        : yield* compileChild(this.#statementTask(block, scope));
    this.#reachable = reachable;
    return continues;
  }

  /**
   * The body of a `repeat` or `for` loop, which may run any number of times, including none. Returns whether the body
   * can end normally or leave through a `break`. A body that certainly runs no time is checked, but nothing in it can
   * be reached.
   */
  *#loopBodyTask(
    body: Block,
    scope: Scope,
    variable: Variable | null,
    reached: boolean,
  ): CompileTask<boolean> {
    const reachable = this.#reachable;
    if (!reached) this.#reachable = false;
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
    this.#reachable = reachable;
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

  /** A `let`, or the start value of a `global`, which declares the global in the project's names. */
  *#letTask(statement: LetStatement | GlobalStatement, scope: Scope): CompileTask<void> {
    const name = statement.name.name;
    const keyword = statement.kind === "letStatement" ? "let" : "global";
    const written = statement.kind === "letStatement" ? statement.initializer : statement.initial;
    const initializer = unwrap(written);
    if (statement.typeAnnotation === null) this.#declaredBy.set(initializer, name);
    const value =
      initializer.kind === "playMediaExpression"
        ? yield* compileChild(this.#mediaTask(initializer, scope, name))
        : yield* compileChild(this.#expressionTask(written, scope));
    let type: StaticType;
    if (statement.typeAnnotation === null) {
      type = this.#newPlaceType(written, value);
      // A number this variable holds derives from the variable itself, which follows what its first value derives
      // from (rule 1.2).
      this.#follow({ root: statement, path: [] }, value, written.span);
      type = this.#ownType(statement, type);
      this.#reportMixedChoice(
        written,
        (type) =>
          `to keep both, declare a union type, as in '${keyword} ${name}: ${type} = choose ...'`,
      );
    } else {
      type = this.#annotationType(statement.typeAnnotation);
      const place: Place = {
        type,
        label: name,
        subject: `'${name}' is declared as ${typeName(type)}`,
        verb: "start as",
        fix: (rejected, expression) => typeFix(name, type, rejected, expression, keyword),
      };
      const checked = checkedValue(written);
      yield* compileChild(
        this.#storeTask(place, checked, checked === written ? value : this.#typeOf(checked)),
      );
      this.#recordRuntimeCheck(statement, type, `'${name}'`, value);
    }
    const variable: Variable = {
      name,
      type,
      shared:
        statement.kind === "globalStatement"
          ? this.#sharedGlobals.has(name)
          : scope === this.#root && this.#effects.shared.has(name),
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

  /**
   * A placement the compiler knows to be wrong, written to what can only be a camera view, also through an alias, a
   * function result, or a collection element; a value it cannot know is checked at runtime (`TSR050`).
   */
  #checkCameraPlacement(object: StaticType, statement: AssignmentStatement): void {
    const receivers = members(nonNullType(object));
    if (receivers.length === 0 || !receivers.every((member) => resolved(member).kind === "camera"))
      return;
    const text = staticVisibleText(statement.value);
    if (statement.operator !== "=" || (text !== undefined && text !== "window" && text !== "stage"))
      this.#report(
        typeCode.invalidCameraPlacement,
        'Camera placement must be "window" or "stage".',
        statement.value.span,
      );
  }

  *#assignmentTask(statement: AssignmentStatement, scope: Scope): CompileTask<void> {
    const target = statement.target;
    let place: Place | undefined;
    let variable: Variable | undefined;
    let handle = false;
    /** For an element, the type it may hold now, which can be wider than what may be stored. */
    let read: StaticType | undefined;
    /** The name of a speaker property the store may write, which the runtime checks. */
    let speakerProperty: string | null = null;
    /** A property without a static type, such as one of an `object` or of a value of unknown type. */
    let untyped = false;
    if (target.kind === "identifier") {
      const entry = scope.resolve(target.name);
      if (entry?.kind === "variable") {
        variable = entry.variable;
        place = variablePlace(variable, this.#text);
      }
    } else {
      if (
        unwrap(target.object).kind !== "identifier" ||
        (target.kind === "indexExpression" && statement.operator !== "=")
      )
        this.#relaxNarrowedRoot(target.object, scope);
      const object = yield* compileChild(this.#expressionTask(target.object, scope));
      if (
        target.kind === "propertyAccessExpression" &&
        ["remaining", "repeatDuration", "position"].includes(target.property.name) &&
        members(nonNullType(object)).some((member) =>
          ["timer", "media"].includes(resolved(member).kind),
        )
      )
        this.#reportCalendarTime(statement.value, `'${target.property.name}'`);
      if (target.kind === "indexExpression") {
        const index = yield* compileChild(this.#expressionTask(target.index, scope));
        this.#checkIndex(object, target.object, index, target.index);
        if (statement.operator === "=") {
          const value = yield* compileChild(this.#expressionTask(statement.value, scope));
          const receiver = this.#elementReceiver(target.object, scope, object, value);
          const checked = checkedValue(statement.value);
          yield* compileChild(
            this.#storeElementTask(
              receiver,
              target.object,
              checked,
              checked === statement.value ? value : this.#typeOf(checked),
              scope,
            ),
          );
          this.#recordRuntimeCheck(
            statement,
            elementStoreType(receiver) ?? UNKNOWN_TYPE,
            runtimePlace(target, isDictReceiver(object)),
            value,
          );
          return;
        }
        // An element of a union of lists may be any member's, and what is stored must fit all of them. A compound
        // assignment reads the dict value first, so its key must exist.
        const store = elementStoreType(object);
        const lists = members(nonNullType(object));
        const kind = lists.every(isList) ? "list" : lists.every(isDict) ? "dict" : null;
        if (store !== undefined && kind !== null) {
          const label = expressionLabel(target.object);
          const elements = elementPlace(
            { kind, element: store },
            label,
            isNullable(object),
            this.#text,
            this.#inferredCollection(target.object, scope),
            lists.length === 1 ? this.#pathOf(target.object, scope) : undefined,
          );
          place =
            lists.length === 1
              ? elements
              : {
                  ...elements,
                  subject: `${label === null ? `This ${kind}` : `'${label}'`} holds ${typeName(nonNullType(object)).replaceAll(" | ", " or ")}`,
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
        if (speakers.includes(true)) speakerProperty = name;
        // A speaker shows its text property; any other receiver keeps the value as it is.
        untyped =
          place === undefined && this.diagnostics.length === before && speakers.includes(false);
        handle = mayBe(object, "timer", "media", "camera");
        // A media position, remaining time, or volume write, and a camera view's placement, first wait for the
        // previous message's pacing.
        if (MEDIA_PACED_PROPERTIES.has(name) && mayBe(object, "media")) this.#suspend();
        if (name === "placement" && mayBe(object, "camera")) {
          this.#suspend();
          this.#checkCameraPlacement(object, statement);
        }
      }
    }
    const value = yield* compileChild(this.#expressionTask(statement.value, scope));
    // A mixed `choose` that C2 rejects for the other receivers needs no second message here.
    if (speakerProperty !== null && !(untyped && this.#mixedChoices.has(unwrap(statement.value)))) {
      if (statement.operator === "=" || speakerProperty !== "defaultSaySkippable")
        this.#checkSpeakerProperty(speakerProperty, statement.value, value);
    }
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
      const checked = checkedValue(statement.value);
      yield* compileChild(
        this.#storeTask(
          place,
          checked,
          checked === statement.value ? value : this.#typeOf(checked),
        ),
      );
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
      const [first, second] = [resolved(kept), resolved(value)];
      if (operator === "+" && first.kind === "list" && second.kind === "list") {
        this.#reportMixedJoin(
          "'+='",
          "list",
          first.element,
          second.element,
          [target],
          statement.value.span,
        );
        return;
      }
      const subject = place.subject;
      this.#report(
        typeCode.typeMismatch,
        `${subject}, so ${describeValue(value)} cannot be ${operator === "+" ? "added to" : "subtracted from"} ${place.verb === "contain" ? "an element" : "it"}.${operandFix(nonNullType(kept), value, statement)}`,
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
    else {
      // A joined list decides an element type that no value decided yet, as a store does.
      if (isCollection(resolved(result))) {
        settle(place.type, result, statement.value.span);
        if (place.widening !== undefined) this.#rewiden(place.widening.root);
      }
      if (variable !== undefined) this.#assigned(variable, result);
    }
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
      (literal.kind === "listLiteral" ||
        literal.kind === "setLiteral" ||
        literal.kind === "dictLiteral")
    ) {
      // A collection literal in a union place is checked against the union's collection of its kind, or the first one
      // that takes every element (rule 3.4).
      const kind = literalCollectionKind(literal);
      const candidates = kept.members
        .map(resolved)
        .filter((member): member is CollectionType => member.kind === kind);
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
      (kept.kind === "set" && literal.kind === "setLiteral") ||
      (kept.kind === "dict" && literal.kind === "dictLiteral")
    ) {
      // A declared element type decides what the literal may mix; `list`, `set`, or `dict` of any values does not, so
      // a mixed literal still needs a declared union.
      if (isKnown(kept.element)) this.#mixedLiterals.delete(literal);
      const elements = elementPlace(
        kept,
        place.label,
        isNullable(place.type),
        this.#text,
        place.inferred !== undefined,
        place.widening,
      );
      for (const element of literalElements(literal))
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
            nestedPropertyPlace(known, place, property.name.name, this.#text),
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
              ? `to keep both, declare it as '${this.#keyword(place.label)} ${place.label}: ${written} = ...'`
              : ONE_TYPE_FIX,
        );
      // Widening again repeats earlier work unless settling can add parts (only an undecided, union, collection, or
      // object type can) or this check recorded a widening for the variable since it last widened it again.
      const settled = resolved(place.type);
      const mayGainParts =
        settled.kind === "open" ||
        settled.kind === "union" ||
        settled.kind === "object" ||
        isCollection(settled);
      if (decides) settle(place.type, value, expression.span);
      if (
        decides &&
        place.widening !== undefined &&
        (mayGainParts || this.#unappliedWidening.has(place.widening.root))
      )
        this.#rewiden(place.widening.root);
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
      `${place.subject}, so it cannot ${place.verb} ${describeValue(value)}.${this.#widenedNote(expression)}${checkFirstFix(place.type, value, expression, place.listed) ?? place.fix(value, expression)}`,
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
    this.#unappliedWidening.add(place.root);
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
    this.#unappliedWidening.delete(root);
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
      if (step === "[]") type = isCollection(value) ? value.element : undefined;
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
        const read = LIST_ELEMENT_READS.has(node.property.name);
        // A set member is read as a copy, so what is stored in it is no part of the variable.
        if (read && owner.some((member) => member.kind === "set")) return undefined;
        steps.push(
          read && owner.length === 1 && owner[0]!.kind === "list" ? "[]" : node.property.name,
        );
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
        return ` '${declarationName(origin)}' is a number because ${this.#line(at)} can store a non-whole number in it.`;
    }
    return "";
  }

  /**
   * Whether every part of a value fits a type, looking into nested list, set, and dict literals, whose own types are
   * not decided until a place gives them one. It reports nothing and changes no type.
   */
  *#fitsTask(type: StaticType, expression: Expression): CompileTask<boolean> {
    const literal = unwrap(expression);
    if (
      literal.kind !== "listLiteral" &&
      literal.kind !== "setLiteral" &&
      literal.kind !== "dictLiteral"
    )
      return isAssignable(type, this.#typeOf(expression));
    const kind = literalCollectionKind(literal);
    for (const member of members(nonNullType(type))) {
      if (member.kind === "unknown" || member.kind === "open") return true;
      if (member.kind !== kind) continue;
      let fits = true;
      for (const element of literalElements(literal))
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
    verb?: string,
    listed = false,
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
      isCollection(member)
        ? [
            {
              ...elementPlace(member, label, nullable, this.#text, inferred, owner),
              ...(verb === undefined ? {} : { verb }),
              listed,
            },
          ]
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
    return propertyPlace(type, label, `'${label}'`, this.#text, extendPath(owner, name));
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
   * The type an annotation means. A set holds only text, numbers, true or false, durations, date and time values, and
   * null (ADR 0014, V30 §35).
   */
  #annotationType(annotation: TypeAnnotation): StaticType {
    const pending: TypeAnnotation[] = [annotation];
    while (pending.length > 0) {
      const part = pending.pop()!;
      switch (part.kind) {
        case "namedType":
          break;
        case "listType":
        case "setType":
        case "dictType":
          pending.push(part.element);
          break;
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
    // A global function sees no script variables.
    if (fn.declaration.global) return false;
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
    const outerFile = this.#enterFile(fn.file);
    const outerScope = this.#outer;
    this.#outer = fn.scope;
    const scope = new Scope(fn.scope);
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
    this.#outer = outerScope;
    this.#loops.push(...outerLoops);
    for (const { call, values, literals, file } of fn.pending.splice(0)) {
      this.#mixedLiterals = new Map(literals);
      this.#enterFile(file);
      yield* compileChild(this.#argumentsTask(fn, call, values));
      this.#reportMixedLiterals();
    }
    this.#enterFile(fn.file);
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
    this.#enterFile(outerFile);
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
    const scope = new Scope(fn.scope);
    const outerFlow = this.#flow;
    this.#flow = new Flow();
    const outerFile = this.#enterFile(fn.file);
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
    this.#enterFile(outerFile);
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
      fn.pending.push({
        call: expression,
        file: this.#file,
        values,
        literals: this.#takeMixedLiterals(expression),
      });
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
      else if (node.kind === "dictLiteral")
        for (const entry of node.entries) pending.push(entry.value);
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
      case "durationLiteral": {
        const parts = durationLiteralParts(expression);
        if (typeof parts === "string")
          this.#report(
            typeCode.invalidOperand,
            `${parts}; a calendar duration counts whole days or months. Write the exact time instead, as in '36 h'.`,
            expression.span,
          );
        return DURATION_TYPE;
      }
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
      case "dictLiteral": {
        // Each key is text; the values share one type like the elements of a list (rule 1.3).
        const types: StaticType[] = [];
        for (const entry of expression.entries) {
          const key = yield* compileChild(this.#expressionTask(entry.key, scope));
          this.#checkDictKey(key, entry.key);
          yield* compileChild(this.#expressionTask(entry.value, scope));
          types.push(this.#capture(entry.value));
        }
        const known = types.filter((type) => resolved(type).kind !== "unknown");
        const choice = expression.entries.find((entry) =>
          this.#mixedChoices.has(unwrap(entry.value)),
        );
        let element = types.length === 0 ? openType() : joinTypes(known);
        if (choice !== undefined) {
          this.#mixedLiterals.set(
            expression,
            members(this.#mixedChoices.get(unwrap(choice.value))!),
          );
          element = undefined;
        }
        if (element === undefined && choice === undefined)
          this.#mixedLiterals.set(expression, known);
        if (element === undefined || known.length < types.length) element = UNKNOWN_TYPE;
        return { kind: "dict", element };
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
        this.#checkVisibleKey(expression.object, expression.index);
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
      case "showCameraExpression":
        this.#suspend();
        return { kind: "camera" };
      case "showPermanentButtonExpression":
        yield* compileChild(this.#permanentButtonTask(expression, scope));
        return { kind: "permanentButton" };
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
      case "tagQueryExpression":
        for (const step of expression.steps) {
          if (step.kind === "tagCompare") {
            const type = yield* compileChild(this.#expressionTask(step.bound, scope));
            this.#reportUnless(
              type,
              isNumeric,
              step.bound,
              "A tag's number is compared with a number",
            );
          } else if (step.kind === "tagList") {
            const type = yield* compileChild(this.#expressionTask(step.value, scope));
            this.#reportUnless(
              type,
              (member) =>
                (member.kind === "list" || member.kind === "set") &&
                (!isKnown(member.element) || isScalar(member.element, "string")),
              step.value,
              `'${step.option}:' takes a list of tag names`,
            );
          }
        }
        this.#checkTagQueryCanMatch(expression);
        // An image is its path; a file is a script reference to its top.
        return expression.select === "list"
          ? { kind: "list", element: expression.catalog === "scripts" ? SCRIPT_TYPE : STRING_TYPE }
          : expression.catalog === "scripts"
            ? SCRIPT_TYPE
            : STRING_TYPE;
    }
  }

  /** Each written tag of a literal `takePhoto(tags: [...])` list is a tag, and no tag has two different numbers. */
  #checkLiteralCaptureTags(tags: Expression): void {
    const list = unwrapGrouping(tags);
    if (list.kind !== "listLiteral") return;
    const seen = new Map<string, Tag>();
    for (const element of list.elements) {
      if (
        element.kind !== "stringLiteral" ||
        element.parts.some((part) => part.kind !== "stringText")
      )
        continue;
      const text = element.parts
        .map((part) => (part.kind === "stringText" ? part.value : ""))
        .join("");
      const tag = readTagText(text);
      if (tag === null) {
        this.#report(
          typeCode.invalidCaptureTag,
          `'${text}' is not a tag: use lowercase letters a–z, digits, and hyphens, with an optional number, such as "punishment: 4".`,
          element.span,
        );
      } else if (addTag(seen, tag) === "conflict") {
        this.#report(
          typeCode.invalidCaptureTag,
          `The tag '${tag.name}' has two different numbers.`,
          element.span,
        );
      }
    }
  }

  /**
   * A pick from the given images that no image can match by its tag tests and literal tag lists alone is an error
   * (ADR 0023). Comparisons and other values count as possibly true: this check does no value reasoning.
   */
  #checkTagQueryCanMatch(query: TagQueryExpression): void {
    // A script query's from: is checked for lists too.
    const scripts = query.catalog === "scripts" ? this.#scriptCandidates(query) : null;
    if (query.select !== "random") return;
    const candidates =
      query.catalog === "scripts"
        ? scripts
        : // A photo taken with tags may match at runtime, so only a project without them can be proven empty.
          this.#capturesTaggedPhotos
          ? null
          : this.#imageTags;
    if (candidates === null) return;
    // Each literal tag list is read once for all candidates.
    const lists = new Map<TagQueryStep, readonly string[] | null>();
    for (const step of query.steps) {
      if (step.kind === "tagList") lists.set(step, literalTagNames(step.value));
    }
    const test = (step: TagQueryStep, tags: ReadonlyMap<string, number | null>) => {
      if (step.kind === "tag") return tags.has(step.name);
      if (step.kind !== "tagList") return null;
      const names = lists.get(step)!;
      return names === null ? null : passesTagList(step.option, names, tags);
    };
    if (
      candidates.some((tags) => evaluateTagSteps(query.steps, (step) => test(step, tags)) !== false)
    )
      return;
    this.#report(
      typeCode.emptyTagQuery,
      query.catalog === "scripts"
        ? "No file in the project that runs something has these tags; a file of declarations only is never picked."
        : candidates.length === 0
          ? "The package has no images to pick from."
          : "No image in the package has these tags.",
      query.span,
    );
  }

  /**
   * The tags of the files a script query may pick or list: every file that runs something, or those its `from:` names.
   * Reports a `from:` that is not a package path or glob, or names no file that runs something; `null` when the
   * project's files are not known.
   */
  #scriptCandidates(query: TagQueryExpression): ReadonlyMap<string, number | null>[] | null {
    if (this.#scriptCatalog === null) return null;
    const runnable = (
      files: readonly { readonly tags: ReadonlyMap<string, number | null> | null }[],
    ) => files.flatMap((file) => (file.tags === null ? [] : [file.tags]));
    const from = query.from;
    if (from === null) return runnable(this.#scriptCatalog);
    const problem = isPathGlob(from.pattern)
      ? packageGlobProblem(from.pattern)
      : packagePathProblem(from.pattern);
    const matched =
      problem === null
        ? new Set(
            globMatches(
              from.pattern,
              this.#scriptCatalog.map((file) => file.path),
            ),
          )
        : new Set<string>();
    const candidates = runnable(this.#scriptCatalog.filter((file) => matched.has(file.path)));
    if (problem !== null || candidates.length === 0) {
      this.#report(
        typeCode.invalidTagQueryFrom,
        problem !== null
          ? `from: '${from.pattern}' is not a package file path or glob: ${problem}.`
          : matched.size === 0
            ? `from: '${from.pattern}' matches no file of the project.`
            : `Every file matching '${from.pattern}' holds declarations only and runs nothing, so there is nothing to pick.`,
        from.span,
      );
      return null;
    }
    return candidates;
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
   * Warns about `==` or `!=` with a value that one side can never hold (ADR 0021 rule 4.5): a `choose` result compared
   * with a value no button returns (#511 C5), or values of types that are never equal, such as text and a number, or a
   * value that is never `null` compared with `null`. {@link #neverMatchingCaseValue} applies it to a literal `case`.
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
      if (otherValues === undefined || mayEqualAny(type, otherValues)) continue;
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
    if (mayCompareEqual(left, right)) return;
    const describesLeft =
      expressionLabel(expression.left) !== null || expressionLabel(expression.right) === null;
    const label = expressionLabel(describesLeft ? expression.left : expression.right);
    this.diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Warning,
        typeCode.constantTest,
        `${label === null ? "This value" : `'${label}'`} holds ${describeValue(describesLeft ? left : right)}, never ${describeValue(describesLeft ? right : left)}, so this comparison is always ${expression.operator === "==" ? "false" : "true"}.`,
        expression.span,
      ),
    );
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
    if (possible === undefined) return undefined;
    // A range matches a number within its bounds, so no button value may fall in it.
    const range = literalRange(value);
    if (range !== undefined) {
      const within = ({ value, duration }: PossibleValue) =>
        typeof value === "number" &&
        !duration &&
        value >= range.start &&
        (range.inclusive ? value <= range.end : value < range.end);
      return possible.some(within)
        ? undefined
        : `${holder} is always ${describeLiterals(possible)} here, so this case never matches.`;
    }
    const literal = comparedLiteral(value);
    if (literal === undefined || mayEqualAny(subject, literal)) return undefined;
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
    this.#checkKnownDurations(expression, left, right);
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
      default: {
        // Two lists whose element types mix are reported as `union()` reports them (V30 §16).
        const [first, second] = [resolved(left), resolved(right)];
        if (
          expression.operator === "+" &&
          first.kind === "list" &&
          second.kind === "list" &&
          arithmeticType("+", first, second) === undefined
        ) {
          const operands = [expression.left, expression.right];
          this.#reportMixedJoin(
            "'+'",
            "list",
            first.element,
            second.element,
            operands,
            expression.span,
          );
          return { kind: "list", element: UNKNOWN_TYPE };
        }
        return this.#operation(expression.operator, [left, right], expression, (a, b) =>
          arithmeticType(expression.operator, a, b),
        );
      }
    }
  }

  /**
   * Reports duration arithmetic that is known to fail (V30 §35): comparing or dividing durations of different
   * families, moving a timestamp by calendar parts or a date by exact time, and calendar parts that would not stay whole.
   * Only the operands a check needs are folded, through `#known`, so any shape of chain stays linear.
   */
  #checkKnownDurations(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
    left: StaticType,
    right: StaticType,
  ): void {
    const leftDuration = isScalar(left, "duration");
    const rightDuration = isScalar(right, "duration");
    if (!leftDuration && !rightDuration) return;
    const operator = expression.operator;
    const duration = (operand: Expression): DurationParts | undefined => {
      const value = this.#known(operand);
      return value !== null && typeof value === "object" ? durationParts(value) : undefined;
    };
    const number = (operand: Expression): number | undefined => {
      const value = this.#known(operand);
      return typeof value === "number" ? value : undefined;
    };
    let problem: string | number | DurationParts | undefined;
    if (operator === "+" || operator === "-") {
      // Only a timestamp or a date moved by a known duration has something to check.
      const moved = isScalar(left, "timestamp")
        ? "timestamp"
        : isScalar(left, "date")
          ? "date"
          : undefined;
      const b = moved !== undefined && rightDuration ? duration(expression.right) : undefined;
      if (b !== undefined && moved === "timestamp" && !isExactDuration(b))
        problem = `a timestamp moves only by exact time such as 24 h, not by ${formatDuration(b)}; convert it with toDateTime() first`;
      else if (b !== undefined && moved === "date" && b.milliseconds !== 0)
        problem = `a date moves only by days, weeks, months, or years, not by ${formatDuration(b)}`;
    } else if (leftDuration && rightDuration) {
      const a = duration(expression.left);
      const b = a === undefined ? undefined : duration(expression.right);
      if (a !== undefined && b !== undefined)
        problem =
          operator === "/"
            ? durationRatio(a, b)
            : ["<", "<=", ">", ">="].includes(operator)
              ? compareDurationParts(a, b)
              : undefined;
    } else if (operator === "*" || operator === "/") {
      // A duration times or divided by a number, or a number times a duration: calendar parts must stay whole.
      const [parts, factor] = leftDuration
        ? [duration(expression.left), number(expression.right)]
        : operator === "*"
          ? [duration(expression.right), number(expression.left)]
          : [undefined, undefined];
      if (parts !== undefined && factor !== undefined)
        problem =
          operator === "*" ? scaleDurationParts(parts, factor) : divideDurationParts(parts, factor);
    }
    if (typeof problem === "string")
      this.#report(typeCode.invalidOperand, `'${operator}': ${problem}.`, expression.span);
  }

  /**
   * The number or duration `expression` is known to have at compile time, folded once per expression from its operands'
   * known values. Iterative, so a long chain of steps does not deepen the native stack.
   */
  #known(expression: Expression): StaticScalar | undefined {
    const pending: Expression[] = [expression];
    while (pending.length > 0) {
      const current = pending.at(-1)!;
      if (this.#knownValues.has(current)) {
        pending.pop();
        continue;
      }
      const missing = knownOperands(current).filter((operand) => !this.#knownValues.has(operand));
      if (missing.length > 0) {
        pending.push(...missing);
        continue;
      }
      this.#knownValues.set(
        current,
        knownStep(current, (operand) => this.#knownValues.get(operand)),
      );
      pending.pop();
    }
    return this.#knownValues.get(expression);
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
      // Null itself counts only when it is all the operand can be; a value that may be null needs a check instead.
      const onlyNull = all.length === 1 && all[0]!.kind === "null";
      const impossible = all.find(
        (member) =>
          (member.kind !== "null" || onlyNull) && isKnown(member) && !possible(member, index),
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
    if (isTakePhotoCall(expression)) {
      const tags = expression.arguments[0]?.value;
      if (tags !== undefined) {
        const type = yield* compileChild(this.#expressionTask(tags, scope));
        this.#reportUnless(
          type,
          (member) =>
            (member.kind === "list" || member.kind === "set") &&
            (!isKnown(member.element) || isScalar(member.element, "string")),
          tags,
          '\'tags:\' takes a list of tags, such as ["bedroom", "punishment: 4"]',
        );
        this.#checkLiteralCaptureTags(tags);
      }
      // A capture waits for the Player like an interaction, and gives a photo reference, or null without a camera.
      this.#suspend();
      return optional(STRING_TYPE);
    }
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
    if (
      (method === "add" || method === "addAll" || method === "get") &&
      unwrap(callee.object).kind !== "identifier"
    )
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
    if (method === "addAll" && members(value).every(isList)) {
      const argument = expression.arguments[0];
      if (argument !== undefined && expression.arguments.length === 1) {
        yield* compileChild(
          this.#addAllTask(expression, callee.object, receiver, argument.value, scope),
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
    // A dict method takes a text key; `get` also takes the value it gives for a missing key.
    let fallback: StaticType | undefined;
    if (isDictReceiver(value) && DICT_METHODS.has(method)) {
      if (!this.#checkDictArguments(expression, method)) return UNKNOWN_TYPE;
      const key = expression.arguments[0];
      if (key !== undefined) {
        this.#checkDictKey(values[0]!, key.value);
        if (method === "remove") this.#checkVisibleKey(callee.object, key.value);
      }
      const defaultArgument = expression.arguments.find(
        (argument) => argument.kind === "namedArgument",
      );
      if (method === "get" && defaultArgument !== undefined) {
        // The result may be the default itself, so it is a copy that later stores to either cannot share.
        fallback = this.#capture(defaultArgument.value);
        // The default is a value the dict could hold: it must fit, and it decides an undecided value type. A default
        // the compiler cannot know is checked when the script runs.
        const collection = this.#elementReceiver(callee.object, scope, receiver, fallback);
        yield* compileChild(
          this.#storeElementTask(
            collection,
            callee.object,
            defaultArgument.value,
            fallback,
            scope,
            "default to",
          ),
        );
        this.#recordRuntimeCheck(
          expression,
          elementStoreType(collection) ?? UNKNOWN_TYPE,
          elementLabel(expressionLabel(callee.object), "dict"),
          fallback,
        );
      }
    } else if (
      (method === "contains" || method === "remove") &&
      expression.arguments.length === 1 &&
      members(nonNullType(value)).some((member) => isDict(resolved(member)))
    )
      // On a union with a dict, the dict takes a text key as well (ADR 0021 rule 3.5).
      this.#checkDictKey(values[0]!, expression.arguments[0]!.value);
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
          return isListOrSet(kept)
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
      const result = all.length === 1 ? results[0]! : union(results.map((result) => result!));
      // A value of unknown type as the default makes the result unknown, so a place checks it when the script runs.
      return fallback === undefined ? result : union([result, plainType(fallback)]);
    }
    const failing = resolved(all.find((_, index) => results[index] === undefined)!);
    if (passing.length > 0) this.#reportMayBe(callee.object, failing, passing);
    // Text operations and values without methods name what to write instead (V30 §8).
    else if (all.length === 1 && MEMBER_CHECKED_KINDS.has(failing.kind)) memberChecks();
    // A set has no order to sort or shuffle (V30 §16).
    else if (
      all.length === 1 &&
      isListOrSet(failing) &&
      failing.kind === "set" &&
      COLLECTION_METHODS.has(method)
    )
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
          : failing.kind === "dict"
            ? method === "add"
              ? "Dicts have no method 'add'; store a value by its key, as in dict[key] = value."
              : `Dicts have no method '${method}'; use contains, remove, clear, or get.`
            : failing.kind === "timer" || failing.kind === "media" || failing.kind === "camera"
              ? handleMemberMessage(failing.kind, method, "call")
              : `${capitalize(describeValue(failing))} has no method '${method}'.`,
        callee.property.span,
      );
    return UNKNOWN_TYPE;
  }

  /**
   * `list.addAll(other)` stores each element of the list `other` in the list as `add` does (V30 §16): the elements of a
   * list literal one by one, and otherwise the element type of `other`, which the runtime checks for each element where
   * it is unknown.
   */
  *#addAllTask(
    call: CallExpression,
    receiverExpression: Expression,
    receiver: StaticType,
    argument: Expression,
    scope: Scope,
  ): CompileTask<void> {
    const type = yield* compileChild(this.#expressionTask(argument, scope));
    this.#reportUnless(type, isList, argument, "addAll() needs a list", () =>
      members(type).some((member) => resolved(member).kind === "set")
        ? " Copy a set into a list with toList() first."
        : "",
    );
    const list = isKnown(nonNullTypeForUse(type))
      ? members(type).every(isList)
        ? elementType(type)
        : undefined
      : UNKNOWN_TYPE;
    // An element type that no value decided yet belongs to an empty list, which adds nothing.
    if (list === undefined || resolved(list).kind === "open") return;
    const collection = this.#elementReceiver(receiverExpression, scope, receiver, list);
    const literal = unwrap(argument);
    if (literal.kind === "listLiteral") {
      // Each element is checked against the list it joins, so the literal itself need not hold one type.
      this.#mixedLiterals.delete(literal);
      for (const element of literal.elements)
        yield* compileChild(
          this.#storeElementTask(
            collection,
            receiverExpression,
            element,
            this.#typeOf(element),
            scope,
          ),
        );
    } else
      yield* compileChild(
        this.#storeElementTask(
          collection,
          receiverExpression,
          argument,
          list,
          scope,
          undefined,
          true,
        ),
      );
    this.#recordRuntimeCheck(
      call,
      elementStoreType(collection) ?? UNKNOWN_TYPE,
      elementLabel(expressionLabel(receiverExpression), "list"),
      list,
    );
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
    // A set operation's argument that may be null needs a check first (owner decision on #504 Q1).
    const operand = expression.arguments[0]?.value;
    if (operand !== undefined && problems.length === 0) {
      const all = members(typeOf(operand));
      const passing = all.filter((member) => member.kind !== "null");
      if (passing.length > 0 && passing.length < all.length) {
        this.#reportMayBe(operand, NULL_TYPE, passing);
        return { kind: value.kind, element: UNKNOWN_TYPE };
      }
    }
    return this.#setOperationType(method, value, expression, problems.length === 0);
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
      if (reportMix) {
        const callee = unwrap(expression.callee);
        const target = callee.kind === "propertyAccessExpression" ? [callee.object] : [];
        this.#reportMixedJoin("union()", receiver.kind, own, other, target, expression.span);
      }
      return { kind: receiver.kind, element: UNKNOWN_TYPE };
    }
    return { kind: receiver.kind, element };
  }

  /**
   * Reports an operation that would give a list or set the elements of two collections whose types mix, such as
   * `union()` or `+`. As for a mixed literal, the fix declares the first of `targets` that is a variable with a union
   * element type.
   */
  #reportMixedJoin(
    operation: string,
    kind: "list" | "set",
    own: StaticType,
    other: StaticType,
    targets: readonly Expression[],
    span: SourceSpan,
  ): void {
    const target = targets.map(unwrap).find((node) => node.kind === "identifier");
    const name = target?.kind === "identifier" ? target.name : "values";
    const mixed: StaticType = { kind, element: union([own, other]) };
    const written = typeName(mixed);
    const property = misfitProperty(own, other);
    const fix =
      property !== undefined
        ? `give '${property.name}' one type in every element`
        : containsType(mixed, (part) => part.kind === "camera")
          ? UNNAMED_MIX_FIX
          : `to keep both, declare a union type, as in '${this.#keyword(name)} ${name}: ${written} = ...'`;
    this.#report(
      typeCode.mixedTypes,
      `${operation} would mix ${mixDescription(own, other)}. A ${kind} holds one type; ${fix}.`,
      span,
    );
  }

  /** Argument and result types of the implemented built-ins; injected host functions return unknown values. */
  #builtinType(
    name: string,
    expression: CallExpression,
    values: readonly StaticType[],
  ): StaticType {
    const argument = expression.arguments[0];
    const value = values[0];
    // A built-in that takes fixed positional arguments checks their values only when their number is right.
    const shape = builtinShapeProblems(name, expression);
    this.#reportProblems(shape);
    if (shape.length > 0) return FIXED_RESULTS.get(name) ?? UNKNOWN_TYPE;
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
      case "removePermanentButton":
        if (argument !== undefined && value !== undefined)
          this.#reportUnless(
            value,
            (member) => member.kind === "permanentButton",
            argument.value,
            "removePermanentButton(...) takes the identifier that showPermanentButton gives",
          );
        return NULL_TYPE;
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
        // #504 Q1): each of its members must be of the family the other arguments decide: numbers, durations, or one kind
        // of date or time value.
        const several = problems.every((problem) => problem.kind === "invalidOperand")
          ? expression.arguments.filter((item) => members(this.#typeOf(item.value)).length > 1)
          : [];
        const familyOf = (member: StaticType): string | undefined =>
          isNumeric(member)
            ? "numbers"
            : isScalar(member, "duration")
              ? "durations"
              : isTemporal(member)
                ? typeName(member)
                : undefined;
        const families = expression.arguments.map((item) => [
          ...new Set(members(nonNullType(this.#typeOf(item.value))).map(familyOf)),
        ]);
        const family =
          families.find((one) => one.length === 1 && one[0] !== undefined)?.[0] ??
          families[0]?.find((one) => one !== undefined);
        const spans = new Set(several.map((item) => item.value.span.start.offset));
        this.#reportProblems(problems.filter((problem) => !spans.has(problem.span.start.offset)));
        // Known durations must share one family, also those that would not win (V30 §35).
        const knownFamilies = new Set(
          expression.arguments.map((item) => {
            const value = this.#known(item.value);
            return value !== null && typeof value === "object"
              ? durationFamily(durationParts(value))
              : "zero";
          }),
        );
        knownFamilies.delete("zero");
        if (knownFamilies.size > 1 || knownFamilies.has("mixed"))
          this.#report(
            typeCode.invalidOperand,
            `${name}(...) compares durations of one kind only: exact time, days and weeks, or months and years.`,
            expression.span,
          );
        for (const item of several)
          this.#reportUnless(
            this.#typeOf(item.value),
            (member) => familyOf(member) !== undefined && familyOf(member) === family,
            item.value,
            `${name}(...) needs values of one kind: all numbers, all durations, or all dates, times, datetimes, or timestamps`,
          );
        // The result is an integer when every argument is one, like arithmetic on them (ADR 0021 rule 2.2).
        const numbers = values.map(nonNullTypeForUse);
        if (numbers.length < 2) return UNKNOWN_TYPE;
        if (numbers.every((number) => isScalar(number, "duration"))) return DURATION_TYPE;
        // Date and time values of one kind give a value of that kind (V30 §35).
        if (
          numbers.every(
            (number) => isTemporal(number) && typeName(number) === typeName(numbers[0]!),
          )
        )
          return numbers[0]!;
        let result: StaticType | undefined = numbers[0];
        for (const number of numbers.slice(1))
          result = result === undefined ? undefined : arithmeticType("+", result, number);
        return result !== undefined && isNumeric(result) ? result : UNKNOWN_TYPE;
      }
      case "toString":
      case "toNumber":
      case "toInteger":
      case "toBoolean":
      case "toDate":
      case "toTime":
      case "toDateTime":
      case "toTimestamp":
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
      case "getDate":
      case "getTime":
      case "getDateTime":
      case "getTimestamp":
        // The current date and time take no arguments (V30 §35).
        if (expression.arguments.length > 0)
          this.#report(
            typeCode.argumentCount,
            `${name}() takes no arguments.`,
            expression.arguments[0]!.value.span,
          );
        return name === "getDate"
          ? DATE_TYPE
          : name === "getTime"
            ? TIME_TYPE
            : name === "getDateTime"
              ? DATETIME_TYPE
              : TIMESTAMP_TYPE;
      case "script": {
        // `script(path)` or `script(path, label: name)`, both text (V30 §29).
        const positional = expression.arguments.filter(
          (item) => item.kind === "positionalArgument",
        ).length;
        if (positional !== 1)
          this.#report(
            typeCode.argumentCount,
            `script(...) takes 1 argument (path), received ${positional}. Name a label with label:, as in script("rooms/hall.tease", label: "start").`,
            expression.span,
          );
        for (const [index, item] of expression.arguments.entries()) {
          if (item.kind === "namedArgument" && item.name.name !== "label")
            this.#report(
              typeCode.unknownNamedArgument,
              `script(...) has no parameter '${item.name.name}'; its only named argument is label:.`,
              item.name.span,
            );
          else if (item.kind === "namedArgument" || positional === 1)
            this.#reportUnless(
              values[index]!,
              (member) => isScalar(member, "string"),
              item.value,
              item.kind === "namedArgument"
                ? "label: takes the name of a label as text (string)"
                : "script(...) takes the path of a file as text (string)",
            );
        }
        return SCRIPT_TYPE;
      }
      default:
        return UNKNOWN_TYPE;
    }
  }

  /** The type of `object.name`; every member of a union must have the property (ADR 0021 rule 3.5). */
  #propertyType(
    object: StaticType,
    expression: Extract<Expression, { kind: "propertyAccessExpression" }>,
  ): StaticType | PlaceRead {
    const name = expression.property.name;
    // A known duration of another family has no such count (V30 §35).
    if ((name === "days" || name === "months") && isScalar(object, "duration")) {
      const value = this.#known(expression.object);
      if (value !== null && typeof value === "object") {
        const parts = durationParts(value);
        const family = durationFamily(parts);
        if (family !== "zero" && family !== name)
          this.#report(
            typeCode.invalidOperand,
            `Only a duration of whole ${name === "days" ? "days or weeks" : "months or years"} has .${name}, but this is ${formatDuration(parts)}.`,
            expression.property.span,
          );
      }
    }
    const all = members(object);
    const types = all.map((member) => memberPropertyType(member, name));
    const passing = all.filter((_, index) => types[index] !== undefined);
    if (passing.length === all.length) {
      const type = all.length === 1 ? types[0]! : union(types.map((type) => type!));
      // A set member is read as a copy (ADR 0014), so what changes the copy decides or widens nothing in the set.
      if (LIST_ELEMENT_READS.has(name) && all.some((member) => resolved(member).kind === "set"))
        return copyType(type);
      // A property or an element is read from the place that keeps it.
      return placeRead(type);
    }
    const failing = all.find((_, index) => types[index] === undefined)!;
    if (passing.length > 0) {
      this.#reportMayBe(expression.object, failing, passing);
      return UNKNOWN_TYPE;
    }
    const value = resolved(failing);
    // A timestamp has no local fields until it is converted through the player's zone.
    if (isScalar(value, "timestamp") && temporalFieldType("datetime", name) !== undefined) {
      this.#report(
        typeCode.invalidOperand,
        `A timestamp has no property '${name}'. Convert it first, as in '${expressionLabel(expression.object) ?? "value"}.toDateTime().${name}'.`,
        expression.property.span,
      );
      return UNKNOWN_TYPE;
    }
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
        : value.kind === "dict"
          ? `Dicts have no property '${name}'; use length, keys, or values, or read a value by its key, as in ${expressionLabel(expression.object) ?? "dict"}[${JSON.stringify(name)}].`
          : value.kind === "timer" || value.kind === "media" || value.kind === "camera"
            ? handleMemberMessage(value.kind, name, "read")
            : `${capitalize(describeValue(value))} has no property '${name}'.`,
      expression.property.span,
    );
    return UNKNOWN_TYPE;
  }

  /**
   * Checks `object[index]`: only lists, indexed by a whole number, and dicts, by a text key, are indexed, and every
   * member of a union must be the same one. An object has fixed properties, so it points to a dict.
   */
  #checkIndex(
    object: StaticType,
    objectExpression: Expression,
    index: StaticType,
    expression: Expression,
  ): void {
    const known = members(nonNullType(object)).filter(isKnown).map(resolved);
    if (known.length > 0 && known.every((member) => member.kind === "object")) {
      const key = staticChoiceValue(expression)?.value;
      const name = expressionLabel(objectExpression);
      this.#report(
        typeCode.invalidOperand,
        `Objects have fixed properties. Use a dict to look up by name.${
          typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
            ? ` Read a fixed property as '${name ?? "object"}.${key}'.`
            : ""
        }`,
        expression.span,
      );
      return;
    }
    if (known.length > 0 && known.every((member) => member.kind === "dict")) {
      if (isNullable(object))
        this.#reportUnless(object, (member) => member.kind !== "null", objectExpression, "");
      else this.#checkDictKey(index, expression);
      return;
    }
    if (members(object).some((member) => isKnown(member) && resolved(member).kind !== "list")) {
      this.#reportUnless(
        object,
        (member) => !isKnown(member) || resolved(member).kind === "list",
        objectExpression,
        "Only a list or a dict can be indexed",
      );
      return;
    }
    const position = nonNullTypeForUse(index);
    // A value of unknown type may also be a dict, which takes a text key.
    const keyed = known.length === 0;
    if (isScalar(position, "number"))
      this.#report(
        typeCode.invalidOperand,
        `A list index must be a whole number (integer), but this is ${describeValue(position)}.${this.#widenedNote(expression)}${ROUND_FIX}.`,
        expression.span,
      );
    else
      this.#reportUnless(
        index,
        (member) => isScalar(member, "integer") || (keyed && isScalar(member, "string")),
        expression,
        keyed
          ? "An index is a whole number (integer) for a list, or text (string) for a dict"
          : "A list index is a whole number (integer)",
      );
  }

  /**
   * Checks the arguments of a dict method: `contains(key)` and `remove(key)` take a key, `clear()` none, and
   * `get(key, default: value)` a key and a `default:`. Returns whether they have that form.
   */
  #checkDictArguments(expression: CallExpression, method: string): boolean {
    const positional = expression.arguments.filter(
      (argument) => argument.kind === "positionalArgument",
    );
    const named = expression.arguments.filter((argument) => argument.kind === "namedArgument");
    const unknown = named.find((argument) => method !== "get" || argument.name.name !== "default");
    if (unknown !== undefined) {
      this.#report(
        typeCode.unknownNamedArgument,
        method === "get"
          ? `get(...) has no parameter '${unknown.name.name}'; its only named argument is 'default:'.`
          : `${method}(...) takes no named arguments.`,
        unknown.name.span,
      );
      return false;
    }
    const keys = method === "clear" ? 0 : 1;
    if (positional.length === keys && (method !== "get" || named.length === 1)) return true;
    this.#report(
      typeCode.argumentCount,
      method === "get"
        ? named.length === 0 && positional.length === 1
          ? "get(key, default: value) needs a 'default:' for a missing key. Read a key that must exist as dict[key]."
          : "get(key, default: value) takes one key and a 'default:'."
        : method === "clear"
          ? "clear() takes no arguments."
          : `${method}(key) takes one key.`,
      expression.span,
    );
    return false;
  }

  /** A dict key is text; a number key names the fix, `"${id}"`. */
  #checkDictKey(type: StaticType, expression: Expression): void {
    this.#reportUnless(
      type,
      (member) => isScalar(member, "string"),
      expression,
      "A dict key is text (string)",
      () =>
        isNumeric(nonNullTypeForUse(type))
          ? ` Write a number key as text, as in "\${${expressionLabel(expression) ?? "id"}}".`
          : "",
    );
  }

  /** A key that a dict literal certainly does not have is reported, as it would fail when the script runs. */
  #checkVisibleKey(dict: Expression, keyExpression: Expression): void {
    const literal = unwrap(dict);
    const key = staticChoiceValue(keyExpression)?.value;
    if (literal.kind !== "dictLiteral" || typeof key !== "string") return;
    const keys = literal.entries.map((entry) => staticChoiceValue(entry.key)?.value);
    if (keys.every((written) => typeof written === "string" && written !== key))
      this.#report(
        typeCode.invalidOperand,
        `Dictionary has no key ${JSON.stringify(key)}.`,
        keyExpression.span,
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
      return interactionResultType(expression.interactionKind);
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
          const value = this.#choiceEntry(element, this.#typeOf(element), true, written === null);
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
          this.#choiceEntry(option.expression, type, false, written === null) !== UNKNOWN_TYPE &&
          !this.#checkElements(
            option.expression,
            type,
            (element) =>
              (written === null ? isChoiceValue(element) : isShowable(element)) ||
              resolved(element).kind === "object",
            () =>
              this.#report(
                typeCode.invalidInteractionChoice,
                "A choice list element must be text, a number, true, false, null, a duration, a date or time value, or a choice object { value?, text, background? }.",
                option.expression.span,
              ),
          );
        // For a computed choice object, only text's known type is checked here; property presence is checked at runtime.
        for (const part of parts)
          if (part.kind === "list" || part.kind === "set")
            for (const element of members(part.element).map(resolved))
              if (element.kind === "object" && element.properties !== null)
                this.#checkChoiceText(option.expression, element.properties);
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
      const entry = this.#choiceEntry(
        option.expression,
        this.#capture(option.expression),
        false,
        written === null,
      );
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
   * text, the button returns, unless `returns` is false because the button returns the value written before `:`.
   * Returns that value's type; a computed choice object's value is not known.
   */
  #choiceEntry(entry: Expression, type: StaticType, inList: boolean, returns: boolean): StaticType {
    const value = resolved(nonNullType(type));
    // A button comes from a value or a choice object; a list or set gives buttons only as a whole option.
    const accepted = (member: StaticType): boolean => {
      const kind = resolved(member).kind;
      return (
        (returns ? isChoiceValue(member) : isShowable(member)) ||
        kind === "object" ||
        (!inList && (kind === "list" || kind === "set"))
      );
    };
    const rejected = this.#checkMembers(entry, type, accepted, (member) =>
      this.#report(
        typeCode.invalidInteractionChoice,
        inList && (member.kind === "list" || member.kind === "set")
          ? "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set."
          : isScalar(member, "script")
            ? SCRIPT_CHOICE_MESSAGE
            : "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
        entry.span,
      ),
    );
    if (rejected) return UNKNOWN_TYPE;
    const literal = unwrap(entry);
    if (literal.kind !== "objectLiteral") {
      // For a computed choice object, only text's known type is checked here; property presence is checked at runtime.
      for (const member of members(nonNullType(type)).map(resolved))
        if (member.kind === "object" && member.properties !== null)
          this.#checkChoiceText(entry, member.properties);
      return value.kind === "object" ? UNKNOWN_TYPE : type;
    }
    let returned: StaticType = UNKNOWN_TYPE;
    for (const property of literal.properties) {
      const propertyType = this.#typeOf(property.value);
      if (property.name.name === "text") {
        this.#checkShownText(property.value, propertyType, "the text of a choice option");
        if (!literal.properties.some((other) => other.name.name === "value")) {
          returned = propertyType;
          // The button returns its text, so the text must be a choice value too.
          if (returns)
            this.#checkMembers(
              property.value,
              propertyType,
              (member) => !isScalar(member, "script"),
              () =>
                this.#report(
                  typeCode.invalidInteractionChoice,
                  SCRIPT_CHOICE_MESSAGE,
                  property.value.span,
                ),
            );
        }
      } else if (property.name.name === "value") {
        this.#checkMembers(property.value, propertyType, isChoiceValue, () =>
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

  /**
   * A computed choice object's text that can never be shown fails whether it is there or missing, so its type alone
   * decides. A text that may be null, unknown, or of a type that can be shown may still give a button.
   */
  #checkChoiceText(expression: Expression, table: PropertyTable): void {
    const text = table.get("text");
    if (text === undefined) return;
    const shown = (member: StaticType): boolean =>
      !isKnown(member) || resolved(member).kind === "null" || isShowable(member);
    if (!members(text).some(shown))
      this.#checkShownText(expression, text, "the text of a choice option");
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
            member.kind === "dict"
              ? `"\${...}" cannot show a dict. Select one value with ${expressionLabel(expression) ?? "dict"}[key], or show every value with ${expressionLabel(expression) ?? "dict"}.values.join().`
              : `"\${...}" cannot show ${describeValue(member)}. It shows text, numbers, true, false, null, durations, date and time values, and script references, and selects one element of a list.`,
            expression.span,
          ),
      );
      if (!reported)
        this.#checkElements(expression, type, isShowable, () =>
          this.#report(
            typeCode.unshowableValue,
            "An interpolated list may contain only text, numbers, true, false, null, durations, date and time values, and script references, because one element is shown as text.",
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
          "An interpolated list may contain only text, numbers, true, false, null, durations, date and time values, and script references, because one element is shown as text.",
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
      else {
        this.#reportCalendarTime(option.value, "A showButton timeout");
        this.#reportUnless(
          type,
          (member) => isNumeric(member) || isScalar(member, "duration"),
          option.value,
          "A showButton timeout is a duration such as '30 s', or a number of seconds",
        );
      }
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

  /**
   * A speaker property that the runtime checks when it is set: `defaultSaySkippable` is true or false. A name part is
   * shown as text; the runtime checks that it is text only when it prepares the speaker's messages.
   */
  #checkSpeakerProperty(name: string, expression: Expression, type: StaticType): void {
    if (name === "defaultSaySkippable")
      this.#reportUnless(
        type,
        (member) => isScalar(member, "boolean"),
        expression,
        "defaultSaySkippable is true or false (boolean)",
      );
    else if (SPEAKER_TEXT_PROPERTIES.has(name))
      this.#checkShownText(expression, type, `the speaker's ${name}`);
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
    kind: Exclude<InteractionExpression["interactionKind"], "choice">,
    expression: Expression,
    type: StaticType,
  ): void {
    const name = expression.kind === "identifier" ? expression.name : null;
    const holds = !isKnown(type)
      ? ""
      : name === null
        ? `, not ${describeValue(type)}`
        : `, but '${name}' holds ${describeValue(type)}`;
    if (kind === "date" || kind === "time" || kind === "datetime") {
      // A date or time field shows its default as ISO text; text is converted first (V30 §20, §35).
      const expected = interactionResultType(kind);
      if (!isAssignable(expected, type))
        this.#report(
          typeCode.invalidInteractionDefault,
          `The default answer of ${TEMPORAL_ASKS[kind]} must be ${describeValue(expected)}${holds}.${
            resolved(type).kind === "null"
              ? EMPTY_FIELD_FIX
              : isNullable(type) && isAssignable(expected, nonNullType(type))
                ? (checkFirstFix(expected, type, expression) ?? "")
                : isScalar(type, "string")
                  ? ` Convert the text with ${TEMPORAL_CONVERSION_NAMES[kind]}(...).`
                  : ""
          }`,
          expression.span,
        );
      return;
    }
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
    if (!unit) this.#reportCalendarTime(expression, "A time");
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

  /** Reports a duration known to have calendar days or months where elapsed time is measured (V30 §35). */
  #reportCalendarTime(expression: Expression, subject: string): void {
    const known = staticChoiceValue(expression)?.value;
    if (known === null || typeof known !== "object") return;
    const parts = durationParts(known);
    if (!isExactDuration(parts))
      this.#report(
        typeCode.invalidOperand,
        `${subject} needs an exact duration such as 24 h, but ${formatDuration(parts)} has calendar days or months, which have no fixed length.`,
        expression.span,
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
    if (timer.handler !== null)
      this.#handlers.push({
        block: timer.handler,
        selfHandle: null,
        scope: this.#outer,
        file: this.#file,
      });
  }

  /** A button's text is shown text; its block runs later, when the player clicks it, like a timer expiry block. */
  *#permanentButtonTask(button: ShowPermanentButtonParts, scope: Scope): CompileTask<void> {
    this.#checkShownText(
      button.text,
      yield* compileChild(this.#expressionTask(button.text, scope)),
      "a button label",
    );
    this.#handlers.push({
      block: button.handler,
      selfHandle: null,
      scope: this.#outer,
      file: this.#file,
    });
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
      else if (media.repeat?.kind === "value" && operand === media.repeat.value) {
        yield* compileChild(
          this.#requireTask(
            operand,
            scope,
            (type) => isScalar(type, "boolean", "duration"),
            "Repeat is true, false, or a duration",
          ),
        );
        this.#reportCalendarTime(operand, "A repeat budget");
      } else yield* compileChild(this.#timeTask(operand, false, scope));
    }
    for (const block of mediaHandlerBlocks(media))
      this.#handlers.push({
        block,
        selfHandle: media.async ? selfHandle : null,
        scope: this.#outer,
        file: this.#file,
      });
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

  /** Reports list and set literals that mix types and were not stored in a place of a declared element type. */
  #reportMixedLiterals(): void {
    for (const [literal, types] of this.#mixedLiterals) {
      const kind =
        literal.kind === "setLiteral" ? "set" : literal.kind === "dictLiteral" ? "dict" : "list";
      const first = types[0]!;
      const other = types.find((type) => joinTypes([first, type]) === undefined) ?? types[1]!;
      const mixed: StaticType = { kind, element: union(types) };
      const written = typeName(mixed);
      const name = this.#declaredBy.get(literal);
      const property = misfitProperty(first, other);
      // A property type has no written form, so objects that disagree need one type for that property.
      const fix =
        property !== undefined
          ? `give '${property.name}' one type in every element`
          : containsType(mixed, (part) => part.kind === "camera")
            ? UNNAMED_MIX_FIX
            : `to keep both, declare a union type, as in '${name === undefined ? `let values: ${written}` : `${this.#keyword(name)} ${name}: ${written}`} = ...'`;
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
  "showCameraStatement",
  "hideCameraStatement",
  "saveStatement",
  "deleteStatement",
  // Blocks of the caller keep running while a called file runs.
  "callFileStatement",
]);

/** What a program's loops and functions may change (ADR 0021 rule 5.5). */
interface ProgramEffects {
  /** Names that function bodies and timer or media blocks assign. */
  readonly shared: ReadonlySet<string>;
  /** Names that the file's top level assigns, which another file's `call` may run (ADR 0022 §5). */
  readonly rootAssigned: ReadonlySet<string>;
  /** Whether the file calls a file, so another file's top level may run during the call. */
  readonly callsFiles: boolean;
  /** Whether the file enters `main.tease` again at its top, after the start values have run. */
  readonly entersMain: boolean;
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
  const rootAssigned = new Set<string>();
  let callsFiles = false;
  let entersMain = false;
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
          expression.kind === "showCameraExpression" ||
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
          else rootAssigned.add(root);
          loop?.assigned.add(root);
        }
      }
      handlers(expression);
      for (const part of expressionParts(expression)) work.push({ expression: part, loop, inside });
      continue;
    }
    const statement = item.statement;
    if (loop !== null && SUSPENDING_STATEMENTS.has(statement.kind)) loop.suspends = true;
    if (statement.kind === "callFileStatement") callsFiles = true;
    if (
      (statement.kind === "gotoStatement" ||
        statement.kind === "callFileStatement" ||
        statement.kind === "fallbackStatement") &&
      statement.target !== null &&
      entersMainAtTop(statement.target)
    )
      entersMain = true;
    // The `default:` form of a global assigns it where the declaration runs.
    if (statement.kind === "globalStatement" && statement.assignment !== null)
      (inside ? shared : rootAssigned).add(statement.name.name);
    if (statement.kind === "assignmentStatement") {
      // A store into an element or property changes the variable that holds it, too.
      const root = rootName(statement.target);
      if (root !== null) {
        if (inside) shared.add(root);
        else rootAssigned.add(root);
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
    rootAssigned,
    callsFiles,
    entersMain,
    loops: new Map(
      nodes.map((node) => [node.body, { assigned: node.assigned, suspends: node.suspends }]),
    ),
  };
}

/** The statements that leave a loop or the session, or may: one of them is a way out of the loop it stands in. */
const LOOP_EXITS: ReadonlySet<Statement["kind"]> = new Set([
  "breakStatement",
  "returnStatement",
  "endStatement",
  "exitStatement",
  "gotoStatement",
  "callFileStatement",
]);

/** The engine functions, which only compute a value; a call of any other function may leave a loop. */
const ENGINE_FUNCTIONS: ReadonlySet<string> = new Set(CORE_RUNTIME_BUILTINS);

/** A `while true` loop, and whether its body has a way out. */
interface EndlessLoop {
  readonly statement: Extract<Statement, { kind: "whileStatement" }>;
  readonly parent: EndlessLoop | null;
  exits: boolean;
}

/** A node to walk, with the innermost `while true` around it and whether it stands in a timer or media block. */
type ExitWork = { readonly loop: EndlessLoop | null; readonly handler: boolean } & (
  { readonly statement: Statement } | { readonly expression: Expression }
);

/**
 * Warns about each loop with no way out once it starts (#578): a `while true`, and a top-level `goto` back to an earlier
 * label of its file, whose loop is the statements between them. A `break`, `return`, `end`, `exit`, any other `goto`, a
 * `call` of a file, or a call of a function other than an engine function is a way out wherever it stands in the loop,
 * also in a branch that no value takes. A timer or media block may run during any loop, so when a block of the project
 * has a way out, no loop is reported. Neither is a loop that never runs by the flow of the type check.
 */
function closedLoopWarnings(
  programs: readonly Program[],
  unreachable: ReadonlySet<Statement>,
): readonly (readonly Diagnostic[])[] {
  let blockExits = false;
  const loops: { readonly file: number; readonly loop: EndlessLoop }[] = [];
  const closed = programs.map((): SourceSpan[] => []);
  /** Walks a top-level statement and returns whether it has a way out. */
  const walk = (file: number, root: Statement): boolean => {
    let found = false;
    const work: ExitWork[] = [{ statement: root, loop: null, handler: false }];
    const enter = (
      statements: readonly Statement[],
      loop: EndlessLoop | null,
      handler: boolean,
    ): void => {
      for (let index = statements.length - 1; index >= 0; index -= 1)
        work.push({ statement: statements[index]!, loop, handler });
    };
    const wayOut = (loop: EndlessLoop | null, handler: boolean): void => {
      found = true;
      blockExits ||= handler;
      // A way out of an inner loop is one of the loops around it too.
      for (let node = loop; node !== null && !node.exits; node = node.parent) node.exits = true;
    };
    while (work.length > 0) {
      const item = work.pop()!;
      const { loop, handler } = item;
      // A timer or media block runs later, outside the loop that starts it.
      for (const block of handlerBlocks("expression" in item ? item.expression : item.statement))
        enter(block.statements, null, true);
      if ("expression" in item) {
        const expression = item.expression;
        if (
          expression.kind === "callExpression" &&
          !(expression.callee.kind === "identifier" && ENGINE_FUNCTIONS.has(expression.callee.name))
        )
          wayOut(loop, handler);
        for (const part of expressionParts(expression))
          work.push({ expression: part, loop, handler });
        continue;
      }
      const statement = item.statement;
      if (LOOP_EXITS.has(statement.kind)) wayOut(loop, handler);
      if (statement.kind === "functionDeclaration") {
        enter(statement.body.statements, null, false);
        for (const parameter of statement.parameters)
          if (parameter.defaultValue !== null)
            work.push({ expression: parameter.defaultValue, loop: null, handler: false });
        continue;
      }
      let inner = loop;
      if (isWhileTrue(statement)) {
        inner = { statement, parent: loop, exits: false };
        loops.push({ file, loop: inner });
      }
      enter(nestedStatements(statement), inner, handler);
      for (const expression of statementExpressions(statement))
        work.push({ expression, loop, handler });
    }
    return found;
  };
  for (const [file, program] of programs.entries()) {
    // The number of top-level statements with a way out before each label.
    const labels = new Map<string, number>();
    let count = 0;
    for (const statement of program.statements) {
      if (statement.kind === "labelStatement") labels.set(statement.name.name, count);
      else if (
        statement.kind === "gotoStatement" &&
        statement.target.kind === "labelTarget" &&
        labels.get(statement.target.label.name) === count &&
        !unreachable.has(statement)
      )
        closed[file]!.push(statement.span);
      // A function runs where it is called, and a call is a way out.
      if (walk(file, statement) && statement.kind !== "functionDeclaration") count += 1;
    }
  }
  if (blockExits) return programs.map(() => []);
  for (const { file, loop } of loops)
    if (!loop.exits && !unreachable.has(loop.statement))
      closed[file]!.push(
        createSourceSpan(loop.statement.span.start, loop.statement.condition.span.end),
      );
  return closed.map((spans) =>
    spans
      .sort((left, right) => left.start.offset - right.start.offset)
      .map((span) =>
        createDiagnostic(
          DiagnosticSeverity.Warning,
          typeCode.closedLoop,
          "If this loop starts, it has no way to stop. Add a condition with `break` to leave the loop, or use `exit` to finish the session.",
          span,
        ),
      ),
  );
}

/** Whether a statement is `while true`, with or without parentheses. */
function isWhileTrue(
  statement: Statement,
): statement is Extract<Statement, { kind: "whileStatement" }> {
  if (statement.kind !== "whileStatement") return false;
  const condition = unwrap(statement.condition);
  return condition.kind === "booleanLiteral" && condition.value;
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
  { kind: "list", element: UNKNOWN_TYPE },
];

/** Whether a variable of this type holds a list, set, or dict whose element type no value decided yet. */
function hasUndecidedElements(type: StaticType): boolean {
  return members(nonNullType(type)).some((member) => {
    const value = resolved(member);
    return isCollection(value) && resolved(value.element).kind === "open";
  });
}

/** The methods of a dict. */
const DICT_METHODS: ReadonlySet<string> = new Set(["contains", "remove", "clear", "get"]);

const COLLECTION_CHANGES: ReadonlySet<string> = new Set([
  "add",
  "addAll",
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

/**
 * The statements of the blocks that run as part of a statement: branches and loop bodies, not handler blocks. A
 * `global` with `default:` assigns where it stands.
 */
function nestedStatements(statement: Statement): readonly Statement[] {
  switch (statement.kind) {
    case "globalStatement":
      return statement.assignment === null ? [] : [statement.assignment];
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

/** The timer, media, or permanent button blocks that a statement or expression registers. */
function handlerBlocks(node: Statement | Expression): readonly Block[] {
  if (node.kind === "timerStatement" || node.kind === "timerExpression")
    return node.handler === null ? [] : [node.handler];
  if (node.kind === "showPermanentButtonStatement" || node.kind === "showPermanentButtonExpression")
    return [node.handler];
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
    case "showPermanentButtonStatement":
      return [statement.text];
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
    case "gotoStatement":
    case "callFileStatement":
    case "fallbackStatement":
      return statement.target?.kind === "scriptTarget" ? [statement.target.expression] : [];
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

/**
 * Whether a target may enter main.tease at its top: a file target naming it or a glob that may pick it, and any computed
 * target but a `script(...)` whose literal path names another file.
 */
function entersMainAtTop(target: TransferTarget): boolean {
  if (target.kind === "labelTarget") return false;
  if (target.kind === "fileTarget")
    return target.label === null && globMatches(target.path, [MAIN_FILE_PATH]).length > 0;
  const reference = unwrap(target.expression);
  const path =
    reference.kind === "callExpression" &&
    reference.callee.kind === "identifier" &&
    reference.callee.name === "script"
      ? reference.arguments.find((argument) => argument.kind === "positionalArgument")?.value
      : undefined;
  const literal = path === undefined ? null : unwrap(path);
  const text =
    literal?.kind === "stringLiteral" && literal.parts.every((part) => part.kind === "stringText")
      ? literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("")
      : null;
  // Only a literal path is known, and only one to another file stays out of main.tease.
  return text === null || text === MAIN_FILE_PATH;
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

/** What a store checks at compile time: for a load, its default; the loaded value itself is checked at runtime. */
function checkedValue(expression: Expression): Expression {
  const value = unwrap(expression);
  return value.kind === "loadExpression" && value.defaultValue !== null
    ? value.defaultValue
    : expression;
}

function variablePlace(variable: Variable, text: PlaceText): Place {
  const name = variable.name;
  const type = variable.type;
  return {
    type,
    widening:
      variable.declaration === undefined ? undefined : { root: variable.declaration, path: [] },
    inferred: variable.declaration === undefined ? undefined : "variable",
    label: name,
    subject: `'${name}' holds ${describeValue(type)}${decidedAt(type, text.line)}`,
    verb: "be set to",
    fix: (rejected, expression) => typeFix(name, type, rejected, expression, text.keyword(name)),
  };
}

function elementPlace(
  collection: CollectionType,
  name: string | null,
  nullable: boolean,
  text: PlaceText,
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
        : `${subject} holds ${typeName(element).replaceAll(" | ", " or ")} values (${typeName(collection)})${decidedAt(collection.element, text.line)}`,
    verb: "contain",
    fix: (value) => elementFix(name, collection, value, nullable, text.keyword(name)),
  };
}

/** The place of a property inside a stored object literal, named after the place that keeps the object. */
function nestedPropertyPlace(type: StaticType, owner: Place, name: string, text: PlaceText): Place {
  const widening = extendPath(owner.widening, name);
  if (owner.label !== null)
    return propertyPlace(
      type,
      `${owner.label}.${name}`,
      `'${owner.label}.${name}'`,
      text,
      widening,
    );
  const subject =
    owner.elementOf === undefined || owner.elementOf === null
      ? `Property '${name}'`
      : `Property '${name}' of the elements of '${owner.elementOf}'`;
  return propertyPlace(type, null, subject, text, widening);
}

function propertyPlace(
  type: StaticType,
  label: string | null,
  name: string,
  text: PlaceText,
  widening?: PlacePath,
): Place {
  return {
    type,
    widening,
    // No type can be written for a property.
    inferred: "part",
    label,
    subject: `${name} holds ${describeValue(type)}${decidedAt(type, text.line)}`,
    verb: "be set to",
    fix: (value, expression) => {
      const conversion = conversionFix(type, value, expression);
      return conversion ?? " Use a separate property for a value of another type.";
    },
  };
}

/**
 * How a runtime type error names an assignment target, such as `'count'`, `property 'door.locked'`, or `a value of
 * 'toys'` for a value stored in a dict.
 */
function runtimePlace(target: AssignmentStatement["target"], dict = false): string {
  if (target.kind === "identifier") return `'${target.name}'`;
  const object = expressionLabel(target.object);
  if (target.kind === "indexExpression") return elementLabel(object, dict ? "dict" : "list");
  return `property '${object === null ? "" : `${object}.`}${target.property.name}'`;
}

function elementLabel(collection: string | null, kind: "list" | "set" | "dict"): string {
  const part = kind === "dict" ? "a value" : "an element";
  return collection === null ? `${part} of this ${kind}` : `${part} of '${collection}'`;
}

/** `' since line 3'` when the first value stored decided the type, so the message names both places. */
function decidedAt(type: StaticType, line: (span: SourceSpan) => string): string {
  const slot = findDecidedSlot(type);
  return slot === null ? "" : ` since ${line(slot)}`;
}

/** How a message names a line of the sources, and the keyword that declares a variable of a name. */
interface PlaceText {
  readonly line: (span: SourceSpan) => string;
  readonly keyword: (name: string | null) => "global" | "let";
}

/** Names a line of a project's sources as seen from file `from` (see `TypeChecker.#line`). */
type LineNamer = (span: SourceSpan, from: number) => string;

function lineNamer(
  files: readonly { readonly path: string; readonly program: Program }[],
): LineNamer {
  const spanFiles = new WeakMap<object, number>();
  // One file needs no names; otherwise each span of a source tells its file.
  if (files.length > 1)
    files.forEach(({ program }, file) => {
      const pending: unknown[] = [program];
      while (pending.length > 0) {
        const node = pending.pop();
        if (typeof node !== "object" || node === null) continue;
        if (Array.isArray(node)) {
          for (const item of node) pending.push(item);
          continue;
        }
        if ("span" in node && typeof node.span === "object" && node.span !== null)
          spanFiles.set(node.span, file);
        for (const [key, value] of Object.entries(node)) if (key !== "span") pending.push(value);
      }
    });
  return (span, from) => {
    const file = spanFiles.get(span);
    const line = `line ${span.start.line + 1}`;
    return file === undefined || file === from ? line : `${line} of ${files[file]!.path}`;
  };
}

function findDecidedSlot(type: StaticType): SourceSpan | null {
  if (type.kind === "open") return type.resolvedAt;
  if (type.kind === "union")
    for (const member of type.members) if (member.kind === "open") return member.resolvedAt;
  return null;
}

// Types of new places --------------------------------------------------------------------------------------------------

/** The value type of a timer, media, or camera view handle property, or `undefined` when it cannot be read or assigned. */
function handlePropertyType(
  handle: "timer" | "media" | "camera",
  name: string,
  use: "read" | "assign",
): StaticType | undefined {
  if (handle === "camera") return name === "placement" ? STRING_TYPE : undefined;
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
    case "dict":
      // `keys` and `values` are new lists, in entry order.
      if (name === "length") return INTEGER_TYPE;
      if (name === "keys") return { kind: "list", element: STRING_TYPE };
      return name === "values" ? { kind: "list", element: copyType(value.element) } : undefined;
    case "object":
      return value.properties?.get(name) ?? UNKNOWN_TYPE;
    case "timer":
    case "media":
    case "camera":
      return handlePropertyType(value.kind, name, "read");
    case "scalar":
      if (isScalar(value, "string")) return name === "length" ? INTEGER_TYPE : undefined;
      // A duration of whole days or months tells how many (V30 §35).
      if (value.name === "duration")
        return name === "days" || name === "months" ? INTEGER_TYPE : undefined;
      return temporalFieldType(value.name, name);
    case "range":
    case "null":
    case "permanentButton":
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
  if (value.kind === "camera") return undefined;
  if (value.kind === "speaker" || value.kind === "unknown" || value.kind === "open")
    return UNKNOWN_TYPE;
  // Text operations (V30 §8).
  if (isScalar(value, "string")) {
    const member = TEXT_MEMBERS.get(method);
    return member?.parameters ? textResultType(member) : undefined;
  }
  if (value.kind === "scalar") return temporalMethodType(value.name, method);
  if (value.kind === "dict") {
    if (method === "contains") return BOOLEAN_TYPE;
    if (method === "clear") return NULL_TYPE;
    // A removed value leaves the dict, and `get` gives a copy, so the type is a copy for the place that keeps it.
    return method === "remove" || method === "get" ? copyType(value.element) : undefined;
  }
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
    case "addAll":
      return value.kind === "list" ? NULL_TYPE : undefined;
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
function mayBe(type: StaticType, ...kinds: ("timer" | "media" | "camera")[]): boolean {
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
  if (member.kind === "timer" || member.kind === "media" || member.kind === "camera") {
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
  if (member.kind === "dict")
    return {
      problem: `Dicts have no properties to assign. Store a value by its key, as in dict["${name}"] = value.`,
      receiver: true,
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

/** Whether a type is a list or a set, which share the collection methods that a dict does not have. */
function isListOrSet(type: StaticType): type is CollectionType & { readonly kind: "list" | "set" } {
  return type.kind === "list" || type.kind === "set";
}

function isDict(type: StaticType): boolean {
  return resolved(type).kind === "dict";
}

/** Whether every known member of a receiver is a dict, so an index is a key. */
function isDictReceiver(type: StaticType): boolean {
  const known = members(nonNullType(type)).filter(isKnown);
  return known.length > 0 && known.every(isDict);
}

/** The collection a list, set, or dict literal builds. */
function literalCollectionKind(
  literal: Extract<Expression, { kind: "listLiteral" | "setLiteral" | "dictLiteral" }>,
): CollectionType["kind"] {
  return literal.kind === "listLiteral" ? "list" : literal.kind === "setLiteral" ? "set" : "dict";
}

/** The elements of a list or set literal, or the values of a dict literal. */
function literalElements(
  literal: Extract<Expression, { kind: "listLiteral" | "setLiteral" | "dictLiteral" }>,
): readonly Expression[] {
  return literal.kind === "dictLiteral"
    ? literal.entries.map((entry) => entry.value)
    : literal.elements;
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

/** The fix for a mix whose union type has no written form, because a camera view's type has no name. */
const UNNAMED_MIX_FIX =
  "a camera view's type cannot be declared, so keep camera views apart from other values";

/** Value kinds that `${...}` cannot show. */
const UNSHOWABLE_KINDS: ReadonlySet<StaticType["kind"]> = new Set([
  "list",
  "set",
  "dict",
  "object",
  "range",
  "timer",
  "media",
  "camera",
  "permanentButton",
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
  // An exact duration is compared by its length, so it stands for its milliseconds in a duration type. A calendar
  // duration has no fixed length and is not tracked.
  if (known === null || typeof known !== "object") return known;
  return isExactDuration(durationParts(known)) ? known.milliseconds : undefined;
}

/** The value a compared expression certainly is, such as `"Open"` or `1 s`, or `undefined`. */

/**
 * Whether values of two types may be equal with `==` (structural equality, #509): numbers of either kind may be, two
 * lists, sets, or objects may both be empty, and a type the compiler cannot know may hold anything.
 */
function mayCompareEqual(left: StaticType, right: StaticType): boolean {
  // Only the kinds of values matter, so a list whose element type is not decided yet is still a list.
  const uncertain = (type: StaticType) =>
    !isKnown(type) || members(type).some((part) => !isKnown(part));
  if (uncertain(left) || uncertain(right)) return true;
  return members(left)
    .map(resolved)
    .some((a) =>
      members(right)
        .map(resolved)
        .some((b) =>
          a.kind === "scalar" && b.kind === "scalar"
            ? a.name === b.name || (isNumeric(a) && isNumeric(b))
            : a.kind === b.kind,
        ),
    );
}

function comparedLiteral(expression: Expression): readonly PossibleValue[] | undefined {
  const known = staticChoiceValue(expression);
  if (known === undefined) return undefined;
  const value = known.value;
  if (value !== null && typeof value === "object" && !isExactDuration(durationParts(value)))
    return undefined;
  return [
    value !== null && typeof value === "object"
      ? { value: value.milliseconds, duration: true }
      : { value, duration: false },
  ];
}

/** The earlier `case is T` or `case is not T` that already takes a literal case value, if any. */
function takingTypeCase<
  Case extends { readonly typeTest: SwitchTypeTest; readonly test: StaticType },
>(typeCases: readonly Case[], value: Expression, valueType: StaticType): Case | undefined {
  if (caseValueText(value) === undefined) return undefined;
  // Every duration literal is a duration, also a calendar one such as `1 d` that is not compared as one exact length.
  const duration = isScalar(valueType, "duration");
  const literal = duration ? undefined : comparedLiteral(value)?.[0];
  if (!duration && literal === undefined) return undefined;
  const scalar = literal?.value;
  // Like the runtime type test: a whole number such as `5.0` is an integer.
  const passes = (member: StaticType): boolean =>
    member.kind === "null"
      ? scalar === null
      : member.kind === "scalar" &&
        (duration
          ? member.name === "duration"
          : typeof scalar === "number"
            ? member.name === "number" || (member.name === "integer" && Number.isInteger(scalar))
            : member.name === typeof scalar);
  return typeCases.find(({ typeTest, test }) => members(test).some(passes) !== typeTest.negated);
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

const SCRIPT_CHOICE_MESSAGE =
  "A button cannot return a script reference. Give the buttons text or number values, and pick the script reference from the answer.";

/** Whether a button may return a value of this member type: one that is shown, other than a script reference. */
function isChoiceValue(member: StaticType): boolean {
  return isShowable(member) && !isScalar(member, "script");
}

/** The result types of the built-ins that take fixed positional arguments. */
const FIXED_RESULTS: ReadonlyMap<string, StaticType> = new Map([
  ["random", NUMBER_TYPE],
  ["chance", BOOLEAN_TYPE],
  ["randomInteger", INTEGER_TYPE],
  ["escapeMarkup", STRING_TYPE],
  ["removePermanentButton", NULL_TYPE],
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

/** A slot already decided by its first value at `at`, so a later mismatch can name that line. */
function decidedSlot(type: StaticType, at: SourceSpan): StaticType {
  // A place still undecided, such as one that so far took only null, is decided by its first other value instead.
  if (members(type).some((member) => member.kind === "open")) return type;
  const slot = openType();
  slot.resolved = type;
  slot.resolvedAt = at;
  return slot;
}

/** A literal list, set, dict, or range that certainly has an element, so a loop over it runs at least once. */
/** A literal or constant range with nothing to go through. */
function isEmptyLiteral(expression: Expression): boolean {
  const node = unwrap(expression);
  if (node.kind === "listLiteral" || node.kind === "setLiteral") return node.elements.length === 0;
  if (node.kind === "dictLiteral") return node.entries.length === 0;
  if (node.kind !== "rangeExpression") return false;
  const start = staticNumber(node.start);
  const end = staticNumber(node.end);
  return start !== undefined && end !== undefined && (node.inclusive ? end < start : end <= start);
}

function isNonEmptyLiteral(expression: Expression): boolean {
  const node = unwrap(expression);
  if (node.kind === "listLiteral" || node.kind === "setLiteral") return node.elements.length > 0;
  if (node.kind === "dictLiteral") return node.entries.length > 0;
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

/** The message for a timer, media, or camera view handle member that does not exist or cannot be assigned. */
function handleMemberMessage(
  handle: "timer" | "media" | "camera",
  name: string,
  use: "read" | "assign" | "call",
): string {
  if (handle === "camera")
    return use === "call"
      ? `Camera views have no method '${name}'; hide them with hideCamera.`
      : `Camera views have no property '${name}'; use placement.`;
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
  const duration = (type: StaticType): boolean => isScalar(type, "duration");
  if (["<", "<=", ">", ">="].includes(operator)) {
    const temporal = isTemporal(left!) ? left! : isTemporal(right!) ? right! : undefined;
    if (temporal !== undefined)
      return `'${operator}' compares ${describeValue(temporal)} only with another ${temporalNoun(temporal)}, not with ${describeValue(temporal === left ? right! : left!)}.${expression.kind === "binaryExpression" ? temporalPairFix(expression, operator, left!, right!) : ""}`;
    return `'${operator}' compares two numbers, two texts, or two durations, but these are ${describeValue(left!)} and ${describeValue(right!)}.`;
  }
  const joined =
    operator === "+" && expression.kind === "binaryExpression"
      ? joinMessage(expression, left!, right!)
      : undefined;
  if (joined !== undefined) return joined;
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

/**
 * Why `+` cannot join text or a list with a value of another kind, and what to write instead (V30 §4): the value in the
 * text, `add` for one element, or a list of it. Nothing converts. The left operand's kind names what was meant.
 */
function joinMessage(
  expression: Extract<Expression, { kind: "binaryExpression" }>,
  left: StaticType,
  right: StaticType,
): string | undefined {
  const list = (type: StaticType): boolean => resolved(type).kind === "list";
  const set = (type: StaticType): boolean => resolved(type).kind === "set";
  const text = (type: StaticType): boolean => isScalar(type, "string");
  const value = (operand: Expression): string => operandLabel(operand) ?? "value";
  const named = (operand: Expression, kind: string): string => expressionLabel(operand) ?? kind;
  if ((set(left) || set(right)) && (list(left) || list(right) || (set(left) && set(right))))
    return `'+' joins two texts or two lists, not ${describeValue(left)} and ${describeValue(right)}. ${SET_JOIN_FIX}`;
  if (list(left) && !list(right)) {
    const items = named(expression.left, "list");
    return `'+' joins a list only with another list, not with ${describeValue(right)}. To add one element, use '${items}.add(${value(expression.right)})', or write '${items} + [${value(expression.right)}]' for a new list.`;
  }
  if (text(left) !== text(right) && (text(left) || !list(right))) {
    const other = text(left) ? right : left;
    const fix = isShowable(other)
      ? ` Put the value in the text instead, as in ${interpolationFix(expression)}.`
      : "";
    return `'+' joins text only with other text, not with ${describeValue(other)}.${fix}`;
  }
  if (list(right) && !list(left))
    return `'+' joins a list only with another list, not with ${describeValue(left)}. Write '[${value(expression.left)}] + ${named(expression.right, "list")}' for a new list.`;
  return undefined;
}

const SET_JOIN_FIX = "Join sets with union(), or copy a set into a list with toList() first.";

/** `"Score: ${5}"` for `"Score: " + 5`: plain text as it is written, and the other operand interpolated. */
function interpolationFix(expression: Extract<Expression, { kind: "binaryExpression" }>): string {
  const part = (operand: Expression): string =>
    plainText(operand) ?? `\${${operandLabel(operand) ?? "value"}}`;
  return `"${part(expression.left)}${part(expression.right)}"`;
}

/** The source spelling of a variable or property path, a number or boolean literal, or plain text in quotes. */
function operandLabel(expression: Expression): string | null {
  const text = plainText(expression);
  return (
    expressionLabel(expression) ?? literalText(expression) ?? (text === null ? null : `"${text}"`)
  );
}

/** The text of a one-line string literal without interpolation, as it is written between its quotes. */
function plainText(expression: Expression): string | null {
  const literal = unwrap(expression);
  if (literal.kind !== "stringLiteral" || literal.form !== "singleLine") return null;
  let text = "";
  for (const part of literal.parts) {
    if (part.kind !== "stringText") return null;
    text += part.raw;
  }
  return text;
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

/**
 * How to make a value fit `+=`/`-=` on a place of `operand` type: text takes it inside the text, and a list takes one
 * element with `add` (V30 §4).
 */
function operandFix(operand: StaticType, type: StaticType, statement: AssignmentStatement): string {
  if (isNumeric(operand)) return " Use a number instead.";
  // A timestamp or a date and time moves by a duration as well.
  if (isScalar(operand, "duration", "timestamp", "datetime")) {
    const literal = unwrap(statement.value);
    return literal.kind === "numberLiteral"
      ? ` Give the number a unit, such as '${literal.raw} s'.`
      : " Use a duration such as '2 s' instead.";
  }
  const target = expressionLabel(statement.target);
  if (statement.operator !== "+=" || target === null) return "";
  const value = operandLabel(statement.value) ?? "value";
  if (isScalar(operand, "string") && isShowable(type))
    return ` Put the value in the text instead, as in '${target} += "\${${value}}"'.`;
  if (resolved(operand).kind === "list" && resolved(type).kind !== "set")
    return ` To add one element, use '${target}.add(${value})'.`;
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
  const conversion = [...CONVERSION_RESULTS].find(
    ([, result]) => isTemporalConversionResult(result) && isScalar(kept, result),
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
  listed = false,
): string | undefined {
  const all = members(value);
  const passing = all.filter((member) => isAssignable(target, member));
  if (all.length < 2 || passing.length === 0) return undefined;
  // A value that may be null is checked with `!= null` (owner decision on #504 Q1). Only a plain variable narrows, so
  // a property or element is first kept in a variable.
  const node = unwrap(expression);
  const label = node.kind === "identifier" ? node.name : null;
  // The elements of a list stored at once are tested as that list, such as `more is integer[]`.
  const test =
    !listed && all.every((member) => passing.includes(member) || member.kind === "null")
      ? "!= null"
      : `is ${typeName(listed ? { kind: "list", element: union(passing) } : union(passing))}`;
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
  keyword: "global" | "let" = "let",
): string {
  const nullable = isNullable(target);
  const kept = resolved(nonNullType(target));
  if (resolved(value).kind === "null" && !nullable)
    return isAnnotatable(target)
      ? ` To allow null, declare it as '${keyword} ${name}: ${typeName(target)}? = ...'.`
      : " Use a separate variable for null.";
  if (isScalar(kept, "integer") && isScalar(value, "number"))
    return `${ROUND_FIX}, or declare it as '${keyword} ${name}: number${nullable ? "?" : ""} = ...'.`;
  const conversion = conversionFix(target, value, expression);
  if (conversion !== undefined) return conversion;
  const both = union([target, value]);
  return isAnnotatable(both)
    ? ` To allow both, declare it as '${keyword} ${name}: ${typeName(both)} = ...'.`
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
  collection: CollectionType,
  value: StaticType,
  nullable: boolean,
  keyword: "global" | "let",
): string {
  if (variable !== null && isScalar(collection.element, "integer") && isScalar(value, "number"))
    return ` To allow fractions, declare it as '${keyword} ${variable}: ${typeName({ kind: collection.kind, element: NUMBER_TYPE })}${nullable ? "?" : ""} = ...'.`;
  if (isScalar(collection.element, "duration") && isNumeric(value))
    return " Give the number a unit, such as '5 s'.";
  const both: StaticType = { kind: collection.kind, element: union([collection.element, value]) };
  if (variable !== null && isAnnotatable(both))
    return ` To allow both, declare it as '${keyword} ${variable}: ${typeName(both)}${nullable ? "?" : ""} = ...'.`;
  return ` Use a separate ${collection.kind} for values of another type.`;
}

/** How to turn a known non-boolean value into a condition. */
function conditionFix(value: StaticType, expression: Expression): string {
  const label = expressionLabel(expression);
  if (label === null) return "";
  if (isNumeric(value)) return ` Compare it instead, such as '${label} > 0'.`;
  if (isScalar(value, "string")) return ` Compare it instead, such as '${label} != ""'.`;
  const kind = resolved(value).kind;
  if (kind === "list" || kind === "set" || kind === "dict")
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

/** The type of the answer an `ask...` interaction returns. */
function interactionResultType(
  kind: Exclude<InteractionExpression["interactionKind"], "choice">,
): StaticType {
  switch (kind) {
    case "number":
      return NUMBER_TYPE;
    case "integer":
      return INTEGER_TYPE;
    case "text":
      return STRING_TYPE;
    case "date":
      return DATE_TYPE;
    case "time":
      return TIME_TYPE;
    case "datetime":
      return DATETIME_TYPE;
  }
}

const TEMPORAL_ASKS = { date: "askDate", time: "askTime", datetime: "askDateTime" } as const;
const TEMPORAL_CONVERSION_NAMES = {
  date: "toDate",
  time: "toTime",
  datetime: "toDateTime",
} as const;

function scalarType(name: ScalarTypeName): StaticType {
  return { kind: "scalar", name };
}

/**
 * Whether a top-level statement runs something on its own. A speaker or a `global` without `default:` only declares,
 * like a function, so a file of declarations needs no ending.
 */
function unwrapGrouping(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

/** The tag names of a list literal of quoted names, or `null` for anything else, which only runtime knows. */
function literalTagNames(written: Expression): readonly string[] | null {
  // Grouping changes nothing: `(["a"])` and `[("a")]` are literal lists too.
  const value = unwrapGrouping(written);
  if (value.kind !== "listLiteral") return null;
  const names: string[] = [];
  for (const item of value.elements) {
    const element = unwrapGrouping(item);
    if (
      element.kind !== "stringLiteral" ||
      element.parts.some((part) => part.kind !== "stringText")
    )
      return null;
    const name = normalizeTagName(
      element.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join(""),
    );
    if (name === null) return null;
    names.push(name);
  }
  return names;
}
