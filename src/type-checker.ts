import type { OwnedDiagnosticCode } from "./diagnostic-codes.js";
import type {
  ObjectLiteral,
  AssignmentStatement,
  Block,
  CallArgument,
  CallExpression,
  DurationUnit,
  Expression,
  FunctionDeclaration,
  ForStatement,
  FunctionParameter,
  GlobalStatement,
  Identifier,
  InteractionExpression,
  LetStatement,
  OpenUrlStatement,
  ExportTextStatement,
  ShowPopupParts,
  LoadExpression,
  MediaParts,
  Program,
  PropertyAccessExpression,
  ScalarTypeName,
  SayParts,
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
  messageColorDiagnostics,
  presentationPropertyDiagnostics,
  SPEAKER_PRESENTATION_PROPERTIES,
} from "./authored-presentation.js";
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
  askOperands,
  expressionChildren,
  expressionParts,
  handlerBlocks,
  namedAskArguments,
  mediaHandlerBlocks,
  mediaOperands,
  nestedStatements,
  showButtonOptions,
  statementExpressions,
  timerOperands,
} from "./expression-children.js";
import {
  isBlankTextAnswer,
  isValidInteractionPrefill,
  numberAnswerText,
} from "./interaction-answers.js";
import type {
  FormFieldKind,
  FormNumericKind,
  PlanImage,
  PlanTag,
  PreparedFormShape,
  TypeCheckPlan,
  TypePlan,
} from "./plan/model.js";
import {
  FORM_FIELD_PROPERTIES,
  FORM_FIELD_PROPERTIES_TEXT,
  isFormFieldKind,
  unknownFormTypeMessage,
} from "./form-fields.js";
import type { VariableSite } from "./semantic.js";
import { isAskImageCall, isFileStoreCall, isLockCall, isTakePhotoCall } from "./capture-call.js";
import { lazyDefaultArgument } from "./lazy-defaults.js";
import { canonicalWebUrl, OPEN_URL_FIX, OPEN_URL_RULE } from "./web-url.js";
import {
  emptyImageFilterMessage,
  IMAGE_NO_SOURCE_MESSAGE,
  imageFilterTextProblem,
} from "./image-input.js";
import { evaluateTagSteps, passesTagList } from "./tag-query.js";
import {
  addTag,
  CONFLICTING_TAG_CODE,
  conflictingTagMessage,
  normalizeTagName,
  readTagText,
  type Tag,
} from "./tags.js";
import { CONVERSION_RESULTS, isTemporalConversionResult, numberFromText } from "./conversions.js";
import {
  builtinCallProblems,
  builtinShapeProblems,
  COLLECTION_CHANGES,
  COLLECTION_METHODS,
  noteSharing,
  rootName,
  type Sharing,
  collectionMethodProblems,
  expressionLabel,
  fallbackFix,
  HANDLE_KINDS,
  LIST_REORDERS,
  LIST_SEARCHES,
  mayBeMessage,
  memberProblems,
  positionalMethodProblems,
  RANGE_LIST_FIX,
  type OperationProblem,
} from "./operation-checks.js";
import { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "./language-facts.js";
import { NUMERIC_FUNCTIONS, percentageFailure, type NumericArgument } from "./numeric-functions.js";
import {
  ANGLE_ARITHMETIC_ROUTE,
  ANGLE_FUNCTIONS,
  anglePropertyMessage,
  angleValue,
  formatAngle,
  type StoredAngle,
} from "./angle.js";
import { LIST_FUNCTIONS, listFunctionCheck } from "./list-function-checks.js";
import { rangeListLengthProblem } from "./runtime/collection-operations.js";
import { describeShownValue, shownChoice } from "./runtime/value-types.js";
import {
  buttonBackgroundMessage,
  CHOICE_TEXT_MESSAGE,
  CHOICE_VALUES_MESSAGE,
  choicePropertyMessage,
  EMPTY_CHOICE_MESSAGE,
  isButtonBackground,
  isChoiceObjectProperty,
} from "./choice-rules.js";
import {
  blockingRepeatMessage,
  cameraPlacementMessage,
  FINISH_NEVER_RUNS_MESSAGE,
  fileReferenceRule,
  handleArgumentsMessage,
  handleMemberMessage,
  hasArgumentlessMethods,
  isCameraPlacement,
  isMediaPosition,
  isMediaRange,
  isMediaRepeatCount,
  isRepeatBudget,
  isMediaVolume,
  isTimerDisplay,
  MEDIA_REPEAT_COUNT_RULE,
  MEDIA_REPEAT_RULE,
  MEDIA_VOLUME_RULE,
  mediaPositionMessage,
  mediaRangeMessage,
  mediaVolumeMessage,
  timerDisplayMessage,
  type HandleKind,
} from "./handle-rules.js";
import {
  emptyRangeProblem,
  rangeBoundRule,
  rangeStartProblem,
  rangeText,
  wholeRangeMessage,
  type RangeBounds,
} from "./range-checks.js";
import {
  logicalOperandRule,
  notNumberFix,
  UNIT_AMOUNT_RULE,
  unitAmountFix,
} from "./operand-rules.js";
import { withoutNegativeZero } from "./conversions.js";
import {
  isDelayLength,
  isRoundLength,
  isTimeoutLength,
  negativeDelayMessage,
  pacingMessage,
  reachesSceneTime,
  sceneTimeMessage,
  timeoutLengthMessage,
  timeoutSceneTimeMessage,
  zeroRoundMessage,
} from "./delay-rules.js";
import {
  FOR_SOURCE_RULE,
  isRepeatCount,
  pairLoopRule,
  REPEAT_COUNT_RULE,
  ROUND_COUNT_FIX,
  repeatCountFix,
  repeatCountMessage,
} from "./loop-rules.js";
import {
  compareDurations,
  divideDuration,
  durationFamily,
  durationLiteralValue,
  durationParts,
  durationPropertyMessage,
  durationQuotient,
  DURATION_UNIT_MILLISECONDS,
  formatDuration,
  isCalendar,
  scaleDuration,
  unitValue,
  UNIT_OPERANDS,
  ZERO_DIVISOR,
  type AnyDuration,
} from "./duration.js";
import {
  findVisibleOverflows,
  isStaticDuration,
  knownOperands,
  VISIBLE_OVERFLOW_MESSAGES,
  knownStep,
  staticChoiceValue,
  staticNumber,
  staticVisibleText,
  type StaticScalar,
} from "./static-evaluation.js";
import { MAX_INTERACTION_OPTION_ENTRIES } from "./interaction-limits.js";
import { startValueMessage } from "./start-value-rules.js";
import {
  argumentCountMessage,
  missingDefaultMessage,
  temporalArgumentsMessage,
  unknownNamedArgumentMessage,
} from "./argument-rules.js";
import { caseValueText, impossibleCaseMessage, literalRange } from "./switch-cases.js";
import { createSourceSpan, type SourceSpan } from "./source.js";
import { TEXT_MEMBERS, type TextMember } from "./text-operations.js";
import {
  missingPropertyMessage,
  duplicateEntryMessage,
  missingSpeakerPropertyMessage,
  misspelledPropertyHint,
} from "./object-properties.js";
import { GENDER_TERMS, PERSON_FIELDS, PLAYER, SPEAKER_NAME_LISTS } from "./speaker-terms.js";
import type { SpeakerFlowInput, SpeakerFlowRead, SpeakerFlowStore } from "./speaker-flow.js";
import { placeKey, type WayFacts } from "./way-facts.js";
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
  ANGLE_TYPE,
  CALENDAR_DURATION_TYPE,
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
  decidedValue,
  members,
  PropertyTable,
  type PropertyRead,
  missingPropertyReads,
  flowInto,
  openTables,
  startPropertyLineage,
  misfitProperty,
  nonNullType,
  NULL_TYPE,
  NUMBER_TYPE,
  openType,
  optional,
  placeType,
  freshPlaceType,
  ownNull,
  resolved,
  settle,
  STRING_TYPE,
  TIME_TYPE,
  ABSOLUTE_DATE_TIME_TYPE,
  SCRIPT_TYPE,
  REGEX_TYPE,
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
  decidePath,
  lacksPath,
  holdsAt,
  observe,
  placedSlots,
  nextDecision,
  mayBeUnknown,
  readsHeldUnknown,
  type OpenType,
  numberPaths,
  integerParts,
  ownPartOrigins,
  ownPartOriginsAt,
  type Declaration,
  type Origin,
  type Origins,
  type PartOrigin,
  type StaticType,
} from "./static-types.js";
import { checksProperties, typePlan } from "./type-plans.js";
import {
  accountCopy,
  copiesAccount,
  PLAYER_DECLARATION,
  sessionDeclarations,
  someNode,
} from "./project-globals.js";
import {
  detachedType,
  sameStorageKeyTypes,
  sameDeclaredKeys,
  sameReadKeys,
  sameReadStorageKeyTypes,
  sameType,
  storageKeyTypes,
  typeKey,
  type StorageKeyType,
  type StorageLoad,
} from "./storage-types.js";

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
  /**
   * The declarations of the variables that a timer, media, or button block shares and assigns or changes in place, with
   * how, from name checking.
   */
  readonly sharedWrites?: ReadonlyMap<VariableSite, Sharing>;
  /**
   * The speaker that each `speaker` names, where a message names it with `as` or its properties use it, from name
   * checking.
   */
  readonly speakers?: ReadonlyMap<Identifier, string>;
}

export interface TypeCheckResult {
  /** The diagnostics of each file, in project order. */
  readonly diagnostics: readonly (readonly Diagnostic[])[];
  /** The runtime checks of values the compiler cannot know, by the source of the instruction that stores them. */
  readonly runtimeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>;
  /** The result shape the runtime needs for each `askForm`. */
  readonly formShapes: ReadonlyMap<InteractionExpression, PreparedFormShape>;
  /** Which ways through the source can run, which the checks that follow the compiled plan take from the check. */
  readonly ways: WayFacts;
  /**
   * The statements that the check found never run once their function, block, or file runs, which its narrowing and its
   * loop effects follow: the plan's reachability finds the same ones (tests/reachability-differential.test.ts).
   */
  readonly unreachable: ReadonlySet<Statement>;
  /** What the flow check of speaker properties needs from the check, once the project is lowered (V30 §37). */
  readonly speakerFlow: SpeakerFlowInput;
  /**
   * For each storage key written as a string literal that a load gives a type, the type that every load of it accepts,
   * which a saved value has to fit when the script runs (ADR 0021 §6), sorted by key.
   */
  readonly storageTypes: readonly { readonly key: string; readonly type: TypePlan }[];
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
  | Extract<Statement, { kind: "returnStatement" }>
  | LoadExpression;

const typeCode = {
  duplicateProperty: "TSV007",
  invalidRangeOperand: "TSV010",
  invalidRepeatCount: "TSV011",
  invalidLoopSource: "TSV012",
  argumentCount: "TSV020",
  unknownNamedArgument: "TSV022",
  invalidInteractionChoice: "TSV029",
  invalidTimerHandleMember: "TSV034",
  mixedDurationOperands: "TSV035",
  invalidMedia: "TSV036",
  invalidMediaHandleMember: "TSV037",
  invalidStorageKey: "TSV038",
  invalidInteractionPrefill: "TSV039",
  listInText: "TSV040",
  unshowableValue: "TSV042",
  constantTest: "TSV046",
  typeMismatch: "TSV041",
  invalidOperand: "TSV043",
  mixedTypes: "TSV044",
  invalidListIndex: "TSV045",
  impossibleCase: "TSV049",
  visibleOverflow: "TSV050",
  emptyTagQuery: "TST002",
  invalidCaptureTag: "TST005",
  conflictingTag: CONFLICTING_TAG_CODE,
  invalidTagQueryFrom: "TST006",
  randomStartValue: "TSV055",
  invalidCameraHandleMember: "TSV059",
  unusedFallback: "TSV062",
  changedCopy: "TSV067",
  invalidTimerDisplay: "TSV068",
} as const satisfies Record<string, OwnedDiagnosticCode<"type checker">>;

type TypeErrorCode = OwnedDiagnosticCode<"type checker", "error">;

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
  // Code that never runs changes nothing (rule 5.5). What a loop, function, or block may change leaves out the code that
  // the previous check found never runs, and each such choice is checked from nothing, since all that a check finds,
  // such as the types it decides, rests on the effects it followed. The last check must find that code never runs too:
  // should it not, the next check leaves out only what both found, and the one after that nothing, which always holds.
  // Otherwise, when what the last check found never running would leave out more, the next check leaves out that, a
  // bounded number of times.
  let dead: DeadCode = { statements: new Set(), operands: new Set() };
  let effects = projectEffects(programs, dead);
  let growth = 0;
  let shrinks = 0;
  for (;;) {
    const checked = checkWithEffects(programs, options, onFile, lines, effects);
    const found = checked.dead;
    if (!coversDeadCode(found, dead)) {
      dead =
        shrinks === 0
          ? {
              statements: new Set(
                [...dead.statements].filter((each) => found.statements.has(each)),
              ),
              operands: new Set([...dead.operands].filter((place) => found.operands.has(place))),
            }
          : { statements: new Set(), operands: new Set() };
      shrinks += 1;
      effects = projectEffects(programs, dead);
      continue;
    }
    if (shrinks === 0 && growth < MAX_DEAD_CODE_ROUNDS) {
      const fewer = projectEffects(programs, found);
      if (!sameProjectEffects(fewer, effects)) {
        dead = found;
        effects = fewer;
        growth += 1;
        continue;
      }
    }
    return withVisibleOverflows(checked.result, programs);
  }
}

/**
 * Adds to each file's diagnostics the steps of known values without a finite result (TSV050), which the folds of every
 * round of the check share, so they are found once.
 */
function withVisibleOverflows(
  result: TypeCheckResult,
  programs: readonly Program[],
): TypeCheckResult {
  return {
    ...result,
    diagnostics: result.diagnostics.map((diagnostics, file) => [
      ...findVisibleOverflows(programs[file]!).map((overflow) =>
        createDiagnostic(
          DiagnosticSeverity.Error,
          typeCode.visibleOverflow,
          VISIBLE_OVERFLOW_MESSAGES[overflow.cause],
          overflow.span,
        ),
      ),
      ...diagnostics,
    ]),
  };
}

/** The type check of the project with the effects `effects`, and the code it found never runs (see `checkTypes`). */
function checkWithEffects(
  programs: readonly Program[],
  options: TypeCheckOptions,
  onFile: (file: number) => void,
  lines: LineNamer,
  effects: ProjectEffects,
): { readonly result: TypeCheckResult; readonly dead: DeadCode } {
  // An integer variable is a number when one of its assignments can store a non-whole number, also an assignment
  // after its uses (rule 1.2). A check that finds a new one starts again with that variable declared as a number, so
  // the last check, which finds none, sees every variable with its final type and alone reports. Likewise, a place
  // that starts as null and that a read saw before its first other value, also one in another file, starts again with
  // the type that value gives it, and a fallback for such a place keeps it where that value cannot be carried over.
  const widened: Widened = new Map();
  const decided: Decided = new Map();
  const copies: Copies = new Map();
  const kept: KeptFallbacks = new Set();
  // The custom speaker properties that a store reaches unchecked, which keep no type (see `UncheckedProperties`).
  const unchecked: UncheckedProperties = new Set();
  // A storage key's type comes from all its loads (ADR 0021 §6), also those checked after a save, so a check reads the
  // types the previous check found, and starts again until they stay the same. The first check reads the types that the
  // source alone gives instead (see `storageGuess`): when it found the types it read, as most projects do, it is the
  // check that reads the found types, so no other check is needed for them. A load's own type never depends on them,
  // so they settle at once; the bound only guards against a load type that changes with variable types. When they
  // changed only in what no check reads, such as the loads of a key that a load declares, and nothing else that the
  // next check would read changed, the next check would repeat this one exactly, so it is not run.
  let guess: ReadonlyMap<string, StorageKeyType> | null = storageGuess(programs);
  let guessedAgain = false;
  let storage: ReadonlyMap<string, StorageKeyType> = guess;
  let storageRounds = 0;
  for (;;) {
    const guessed: boolean = storage === guess;
    const uncheckedBefore = guessed ? [...unchecked] : [];
    const checker: TypeChecker = new TypeChecker(
      options,
      widened,
      decided,
      copies,
      kept,
      unchecked,
      storage,
      guessed,
      programs.length,
      onFile,
      lines,
    );
    checker.check(programs, effects);
    // A key whose type the runtime cannot check has none.
    const found: Map<string, StorageKeyType> = new Map(
      [...storageKeyTypes(checker.storageLoads)].filter(([, kept]) => typePlan(kept.type) !== null),
    );
    // What a check found rests on the types its loads read. When a load read a guessed type that is not the one found,
    // the check starts again from nothing, with the found types as the guess. Its loads then read them, since loads
    // take them from declarations, which no check changes; should they not, it starts again without a guess.
    if (guessed && !checker.loadsReadFound(found)) {
      widened.clear();
      decided.clear();
      copies.clear();
      kept.clear();
      unchecked.clear();
      for (const name of uncheckedBefore) unchecked.add(name);
      guess = guessedAgain ? null : found;
      guessedAgain = true;
      storage = guess ?? new Map();
      storageRounds = 0;
      continue;
    }
    // A check that found more of them read those properties with the types they no longer keep, so what it found rests
    // on those types: the next check starts again from nothing but the larger set, which only grows.
    if (checker.uncheckedMore) {
      widened.clear();
      decided.clear();
      copies.clear();
      kept.clear();
      storage = guess ?? new Map();
      storageRounds = 0;
      continue;
    }
    let storageChanged = false;
    // Whether the key types changed in what a check reads (see `sameReadStorageKeyTypes`).
    let storageRead = false;
    if (storageRounds < MAX_STORAGE_ROUNDS) {
      if (guessed) {
        // As for a first check that read no types, they changed from none when it found some, but in what it read only
        // when it found others than it read.
        storageRead = !checker.readsFound(found);
        storageChanged = storageRead || found.size > 0;
        storage = found;
      } else if (!sameStorageKeyTypes(storage, found)) {
        storageRead = !sameReadStorageKeyTypes(storage, found);
        storage = found;
        storageChanged = true;
      }
      if (storageChanged) storageRounds += 1;
    }
    // A load that read its default's type reads the type that another load declares from the next check on, so what
    // this check decided may rest on the wrong type: the next check decides again.
    if (![...checker.keysReadAsDefault].some((key) => storage.get(key)?.declared === true))
      checker.recordDecisions();
    // A check that changed nothing is the last. So is one that changed only key types that no check reads, when it found
    // no new copy and the places that follow widened ones widen no further: the next check would repeat it exactly.
    let last =
      !checker.widenedMore &&
      !checker.decidedMore &&
      !checker.keptMore &&
      (!storageChanged || (!storageRead && !checker.copiedMore));
    let followed = false;
    if (last && storageChanged) {
      checker.widenFollowers();
      followed = true;
      last = !checker.widenedMore;
    }
    if (last) {
      const dead = checker.deadCode();
      return {
        result: Object.freeze({
          diagnostics: Object.freeze(
            checker.fileDiagnostics.map((diagnostics) => Object.freeze(diagnostics)),
          ),
          speakerFlow: checker.speakerFlowInput(),
          runtimeChecks: checker.runtimeChecks(),
          formShapes: checker.formShapes(),
          ways: checker.ways(),
          unreachable: dead.statements,
          storageTypes: storageTypePlans(storage),
        }),
        dead,
      };
    }
    if (!followed) checker.widenFollowers();
  }
}

/** How many checks may still change the storage key types (see {@link checkTypes}). */
const MAX_STORAGE_ROUNDS = 8;

/** How many checks may leave out more code that never runs (see {@link checkTypes}). */
const MAX_DEAD_CODE_ROUNDS = 4;

/** The runtime checks of the storage keys, sorted by key; a type the runtime cannot check has none. */
function storageTypePlans(
  storage: ReadonlyMap<string, StorageKeyType>,
): readonly { readonly key: string; readonly type: TypePlan }[] {
  const plans: { readonly key: string; readonly type: TypePlan }[] = [];
  for (const [key, kept] of storage) {
    const type = typePlan(kept.type);
    if (type !== null) plans.push(Object.freeze({ key, type }));
  }
  plans.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return Object.freeze(plans);
}

/**
 * The storage key types that the source alone gives (ADR 0021 §6), which the first check reads (see {@link checkTypes}).
 * They come from the loads with a key written as a string literal: the type that their `let` or `global` declares, or
 * that every declaration of the variable they are assigned to declares, or else their default's type when the default is
 * a literal. A load whose type only the check can tell, such as one with another default, is left out. The loads are
 * taken as a check takes them: those in the start values of globals and speakers first, then by file, each by position.
 */
function storageGuess(programs: readonly Program[]): Map<string, StorageKeyType> {
  const byPosition = (left: LoadExpression, right: LoadExpression): number =>
    left.span.start.offset - right.span.start.offset;
  const fileLoads: LoadExpression[][] = [];
  const starts: Expression[] = [];
  const declared = new Map<LoadExpression, TypeAnnotation>();
  const assigned = new Map<LoadExpression, string>();
  // The types that the `let`s, `global`s, parameters, and loop variables of each name declare, `null` for none.
  const names = new Map<string, (TypeAnnotation | null)[]>();
  const declare = (name: Identifier, annotation: TypeAnnotation | null): void => {
    const annotations = names.get(name.name) ?? [];
    annotations.push(annotation);
    names.set(name.name, annotations);
  };
  for (const program of programs) {
    const found: LoadExpression[] = [];
    someNode(program, (node) => {
      if (node.kind === "letStatement" || node.kind === "globalStatement") {
        // EVIDENCE: invariant: the parser gives these kinds only to let and global statements.
        const statement = node as LetStatement | GlobalStatement;
        declare(statement.name, statement.typeAnnotation);
        const value = unwrap(
          statement.kind === "letStatement" ? statement.initializer : statement.initial,
        );
        if (statement.typeAnnotation !== null && value.kind === "loadExpression")
          declared.set(value, statement.typeAnnotation);
        if (statement.kind === "globalStatement") starts.push(statement.initial);
      } else if (node.kind === "speakerDeclaration") {
        // EVIDENCE: invariant: the parser gives this kind only to speaker declarations.
        for (const property of (node as SpeakerDeclaration).properties) starts.push(property.value);
      } else if (node.kind === "functionParameter") {
        // EVIDENCE: invariant: the parser gives this kind only to function parameters.
        const parameter = node as FunctionParameter;
        declare(parameter.name, parameter.typeAnnotation);
      } else if (node.kind === "forStatement") {
        // EVIDENCE: invariant: the parser gives this kind only to for statements.
        const statement = node as ForStatement;
        declare(statement.variable, null);
        if (statement.valueVariable !== null) declare(statement.valueVariable, null);
      } else if (node.kind === "assignmentStatement") {
        // EVIDENCE: invariant: the parser gives this kind only to assignments.
        const statement = node as AssignmentStatement;
        const value = unwrap(statement.value);
        if (
          statement.operator === "=" &&
          statement.target.kind === "identifier" &&
          value.kind === "loadExpression"
        )
          assigned.set(value, statement.target.name);
      } else if (node.kind === "loadExpression") {
        // EVIDENCE: invariant: the parser gives this kind only to load expressions.
        found.push(node as LoadExpression);
      }
      return false;
    });
    fileLoads.push(found.sort(byPosition));
  }
  // The start values of globals and speakers come first, by file and position like the declarations that hold them.
  const started = new Set<object>();
  for (const start of starts)
    someNode(start, (node) => {
      if (node.kind === "loadExpression") started.add(node);
      return false;
    });
  const loads = [
    ...fileLoads.flatMap((found) => found.filter((load) => started.has(load))),
    ...fileLoads.flatMap((found) => found.filter((load) => !started.has(load))),
  ];
  // The type that each declaration of a name declares, if they all declare the same one.
  const byName = new Map<string, StaticType | undefined>();
  const declaredByName = (name: string): StaticType | undefined => {
    if (byName.has(name)) return byName.get(name);
    const types = (names.get(name) ?? []).map((annotation) =>
      annotation === null ? null : typeFromAnnotation(annotation),
    );
    const first = types[0] ?? null;
    const text = first === null ? null : typeKey(first, false);
    const type =
      first !== null && types.every((other) => other !== null && typeKey(other, false) === text)
        ? first
        : undefined;
    byName.set(name, type);
    return type;
  };
  const typed: StorageLoad[] = [];
  for (const load of loads) {
    const key = staticText(load.key);
    if (key === undefined) continue;
    const annotation = declared.get(load);
    const name = assigned.get(load);
    const receiver =
      annotation !== undefined
        ? typeFromAnnotation(annotation)
        : name === undefined
          ? undefined
          : declaredByName(name);
    if (receiver !== undefined) {
      typed.push({ key, type: nonNullType(receiver), at: load.span, declared: true });
      continue;
    }
    const fallback =
      load.defaultValue === null ? undefined : runCompileTask(literalTypeTask(load.defaultValue));
    if (fallback === undefined) continue;
    // As in the check, a default of null, or with a type that no value decided, gives the load no type.
    const type = nonNullType(fallback);
    const kind = resolved(type).kind;
    if (kind !== "never" && kind !== "unknown" && kind !== "open")
      typed.push({ key, type, at: load.span, declared: false });
  }
  // A key whose type the runtime cannot check has none.
  return new Map([...storageKeyTypes(typed)].filter(([, kept]) => typePlan(kept.type) !== null));
}

/** The type that a check gives a literal, also one of literals such as `[1, 2]`, or `undefined` for another expression. */
function* literalTypeTask(expression: Expression): CompileTask<StaticType | undefined> {
  switch (expression.kind) {
    case "booleanLiteral":
      return BOOLEAN_TYPE;
    case "nullLiteral":
      return NULL_TYPE;
    case "numberLiteral":
      return expression.numericType === "integer" ? INTEGER_TYPE : NUMBER_TYPE;
    case "durationLiteral":
      return expression.calendar ? CALENDAR_DURATION_TYPE : DURATION_TYPE;
    case "stringLiteral":
      return STRING_TYPE;
    case "parenthesizedExpression":
      return yield* compileChild(literalTypeTask(expression.expression));
    case "listLiteral":
    case "setLiteral": {
      const types: StaticType[] = [];
      for (const element of expression.elements) {
        const type = yield* compileChild(literalTypeTask(element));
        if (type === undefined) return undefined;
        types.push(type);
      }
      // Elements of different types leave the element type unknown, as in the check.
      const element = types.length === 0 ? openType() : (joinTypes(types) ?? UNKNOWN_TYPE);
      return { kind: expression.kind === "listLiteral" ? "list" : "set", element };
    }
    case "objectLiteral": {
      const properties = new PropertyTable();
      for (const property of expression.properties) {
        const type = yield* compileChild(literalTypeTask(property.value));
        if (type === undefined) return undefined;
        properties.set(property.name.name, type);
      }
      return { kind: "object", properties };
    }
    default:
      return undefined;
  }
}

/**
 * The variables, elements, and properties that one of their assignments gives a non-whole number, with the first such
 * assignment: by the declaration of the variable that holds them, then by their path in it (see {@link PlacePath}).
 */
type Widened = Map<Declaration, Map<string, SourceSpan>>;

/**
 * The places still undecided when a read saw them, such as a property that so far took only null, with the type and
 * site of the store that later decided them: by the declaration of the variable that holds them, then by their path.
 */
type Decided = Map<Declaration, Map<string, Decision>>;

/**
 * The places that are a copy of another variable's place taken while that place was undecided, with that variable's
 * name: by the declaration of the variable that holds them, then by their path.
 */
type Copies = Map<Declaration, Map<string, string>>;

/**
 * The `otherwise` expressions, and the assignments to a variable of unknown type, whose value counted as null so far
 * where they were checked, but which a later value decided in a way that a next check cannot start with: their result
 * keeps that value's place (see {@link fallbackType}).
 */
type KeptFallbacks = Set<Expression | AssignmentStatement>;

/**
 * The names of custom speaker properties that a store may reach through a speaker the compiler cannot tell apart, such
 * as a parameter or the speaker of a message, or through a value of unknown type. Such a store is not checked, so no
 * speaker keeps a type for a property of that name: its reads stay of unknown type, which a known place checks when the
 * script runs (ADR 0021 rule 1.7), and stores into it are not checked.
 */
type UncheckedProperties = Set<string>;

/** The type that decided a slot, and the store that decided it. */
interface Decision {
  readonly type: StaticType;
  readonly at: SourceSpan;
}

/**
 * For each given slot, the slot whose own first value decided it by the end of a check, or `null`. A slot shares the decision of the slot it was copied from, since it may hold what that slot held (ADR 0021
 * rule 1.2), and of a still undecided place stored in it, such as `a = b` while `b` took only null. Of all decisions it
 * shares this way, the first in checking order decides, also around a cycle of copies. Every slot is visited once, so a
 * whole chain of copies and stores needs no check per step.
 */
function decidingSlots(slots: readonly OpenType[]): {
  readonly deciding: Map<OpenType, OpenType | null>;
  /** For a slot that shares no decision, where a value the compiler cannot know reached it, if one did. */
  readonly unknown: Map<OpenType, SourceSpan>;
} {
  const starts = [...new Set(slots)];
  // The slots each one shares decisions with, found from the given ones, and those a value of their own decided.
  const sharers = new Map<OpenType, OpenType[]>();
  const own: OpenType[] = [];
  const seen = new Set<OpenType>(starts);
  const work = [...starts];
  while (work.length > 0) {
    const slot = work.pop()!;
    const shared: OpenType[] = [];
    if (slot.copiedFrom !== undefined) shared.push(slot.copiedFrom);
    if (slot.resolved !== null) {
      const stored = storedPlace(slot);
      if (stored === undefined) own.push(slot);
      else shared.push(stored);
    }
    for (const next of shared) {
      const list = sharers.get(next) ?? [];
      list.push(slot);
      sharers.set(next, list);
      if (!seen.has(next)) {
        seen.add(next);
        work.push(next);
      }
    }
  }
  const deciding = new Map<OpenType, OpenType | null>();
  own.sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity));
  for (const decider of own) {
    const reached = [decider];
    while (reached.length > 0) {
      const slot = reached.pop()!;
      if (deciding.has(slot)) continue;
      deciding.set(slot, decider);
      for (const sharer of sharers.get(slot) ?? []) reached.push(sharer);
    }
  }
  for (const slot of starts) if (!deciding.has(slot)) deciding.set(slot, null);
  // A value the compiler cannot know reaches what shares the slot it was stored in, as a decision would.
  const unknown = new Map<OpenType, SourceSpan>();
  for (const holder of seen) {
    if (holder.heldUnknown === undefined) continue;
    const reached = [holder];
    while (reached.length > 0) {
      const slot = reached.pop()!;
      if (unknown.has(slot)) continue;
      unknown.set(slot, holder.heldUnknown);
      for (const sharer of sharers.get(slot) ?? []) reached.push(sharer);
    }
  }
  return { deciding, unknown };
}

/**
 * A check kept for the end of the check: an operation whose operands held only null when it was checked, with what it
 * reports if they still do, or a store of an operation of unknown result into a place that no value decided yet, which
 * is checked against the type a later value decided.
 */
type DeferredCheck = {
  readonly file: number;
  /** Where among the diagnostics of its file the check reports. */
  readonly at: number;
} & (
  | {
      readonly kind: "nullOnly";
      readonly slots: readonly OpenType[];
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly kind: "lateStore";
      readonly place: Place;
      readonly expression: Expression;
      readonly value: StaticType;
    }
  | {
      /**
       * A read of a property that the tables of its objects lacked (#845): a property access, also by `+=` or `-=`, or
       * the property a list function reads from each element, such as `by: "count"`.
       */
      readonly kind: "property";
      readonly site: Expression;
      readonly span: SourceSpan;
      /** The error, or a function for it given the properties that the objects read can have. */
      readonly message: string | ((properties: readonly string[]) => string);
    }
  | {
      /**
       * A read of a field of {@link SPEAKER_FIELDS} from the speaker of this name, or from any speaker for `null`, which
       * fails when the speaker gets none of the field's sources (see {@link fieldSources}).
       */
      readonly kind: "speakerField";
      readonly speaker: string | null;
      readonly name: string;
      readonly span: SourceSpan;
    }
);

/**
 * The undecided slot of a type that so far held only null, such as the type of `v` after `let v = null` once nothing
 * narrows it any more, or `undefined` for any other type. A value that a later store gives may still decide the slot.
 */
function nullOnlySlot(type: StaticType): OpenType | undefined {
  let slot: OpenType | undefined;
  let sawNull = false;
  for (const member of members(type)) {
    const value = resolved(member);
    if (value.kind === "null") sawNull = true;
    else if (
      value.kind === "open" &&
      slot === undefined &&
      value.resolved === null &&
      value.heldUnknown === undefined
    )
      slot = value;
    else return undefined;
  }
  return slot !== undefined && (sawNull || slot.sawNull) ? slot : undefined;
}

/**
 * Whether an undecided slot held only null to the end of a check: no value decided it or a slot it was copied from, and
 * none of them took a value the compiler cannot know. `known` keeps the answer for each slot walked, so a chain of copies
 * that many slots share is walked once.
 */
function heldOnlyNull(slot: OpenType, known: Map<OpenType, boolean>): boolean {
  const walked = new Set<OpenType>();
  let only = true;
  for (
    let current: OpenType | undefined = slot;
    current !== undefined;
    current = current.copiedFrom
  ) {
    const seen = known.get(current);
    if (seen !== undefined) {
      only = seen;
      break;
    }
    if (walked.has(current) || current.resolved !== null || current.heldUnknown !== undefined) {
      only = false;
      break;
    }
    walked.add(current);
  }
  for (const current of walked) known.set(current, only);
  return only;
}

/** The slot itself and the still undecided places stored in it, as far as they lead (see {@link decidingSlots}). */
function storedIn(slot: OpenType): Set<OpenType> {
  const chain = new Set<OpenType>();
  for (let current: OpenType | undefined = slot; current !== undefined && !chain.has(current);) {
    chain.add(current);
    current = storedPlace(current);
  }
  return chain;
}

/**
 * The still undecided place whose value a decided slot holds, such as `b` after `a = b` while `b` took only null, or
 * `undefined` when a value of its own decided it.
 */
function storedPlace(slot: OpenType): OpenType | undefined {
  if (slot.resolved === null) return undefined;
  const parts = slot.resolved.kind === "union" ? slot.resolved.members : [slot.resolved];
  const open = parts.find((part): part is OpenType => part.kind === "open");
  return open !== undefined && parts.every((part) => part.kind === "open" || part.kind === "null")
    ? open
    : undefined;
}

/**
 * Whether a slot's decision may be replayed although parts of it are still undecided (see `recordDecisions`): only when
 * nothing it reaches through copies and decided slots holds itself, which each later check would decide one level
 * deeper, or held a value the compiler cannot know, which a new slot would forget. A value the compiler cannot know
 * that the slot itself held does not count: the next check stores it again, into the decided type (#859). Each slot is
 * visited once.
 */
function replayableDecisions(): (decider: OpenType) => boolean {
  /** For each visited slot, whether it reaches neither a cycle nor a value the compiler cannot know. */
  const verdicts = new Map<OpenType, boolean>();
  return (decider) => {
    const onPath = new Set<OpenType>();
    const frames: { slot: OpenType; next: OpenType[]; clean: boolean }[] = [];
    const enter = (slot: OpenType, own = false): void => {
      onPath.add(slot);
      frames.push({ slot, next: slotEdges(slot), clean: own || slot.heldUnknown === undefined });
    };
    // The verdict on the slot's own value is not kept for a slot that reaches this one.
    const own = decider.heldUnknown !== undefined;
    if (own || !verdicts.has(decider)) enter(decider, own);
    let verdict = verdicts.get(decider);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const next = frame.next.pop();
      if (next === undefined) {
        frames.pop();
        onPath.delete(frame.slot);
        if (frame.slot === decider && own) verdict = frame.clean;
        else verdicts.set(frame.slot, frame.clean);
        // What a slot reaches, the slots that reach it reach too.
        if (!frame.clean && frames.length > 0) frames[frames.length - 1]!.clean = false;
      } else if (onPath.has(next) || verdicts.get(next) === false) frame.clean = false;
      else if (!verdicts.has(next)) enter(next);
    }
    return verdict ?? verdicts.get(decider)!;
  };
}

/** The slots a slot's type depends on: the one it was copied from, and those directly in the type that decided it. */
function slotEdges(slot: OpenType): OpenType[] {
  const edges: OpenType[] = slot.copiedFrom === undefined ? [] : [slot.copiedFrom];
  const pending: StaticType[] = slot.resolved === null ? [] : [slot.resolved];
  while (pending.length > 0) {
    const part = pending.pop()!;
    if (part.kind === "open") edges.push(part);
    else if (part.kind === "union") for (const member of part.members) pending.push(member);
    else if (isCollection(part)) pending.push(part.element);
    else if (part.kind === "object" && part.properties !== null)
      for (const value of part.properties.values()) pending.push(value);
  }
  return edges;
}

/** The name of the variable a declaration creates. */
function declaredName(declaration: Declaration): string {
  if (declaration.kind === "identifier") return declaration.name;
  return declaration.kind === "forStatement" ? declaration.variable.name : declaration.name.name;
}

/**
 * Where a place is inside a variable without a type annotation: the steps from the variable, each a property name or `[]`
 * for the elements of a list or set. The variable itself has no steps.
 */
interface PlacePath {
  readonly root: Declaration;
  readonly path: readonly string[];
}

/**
 * Whether a path, written as a key of {@link Widened}, is one of `keys` or lies inside one of them: whether it or one of
 * the paths that lead to it is in `keys`, where `""` is the whole variable.
 */
function withinKeys(path: string, keys: ReadonlySet<string>): boolean {
  if (keys.has("") || keys.has(path)) return true;
  for (let end = path.indexOf("."); end !== -1; end = path.indexOf(".", end + 1))
    if (keys.has(path.slice(0, end))) return true;
  return false;
}

/** A part of a variable that a store added to or decided, with its path there (see `TypeChecker.#rewiden`). */
interface ChangedPart {
  readonly path: readonly string[];
  readonly part: StaticType;
}

function extendPath(owner: PlacePath | undefined, step: string): PlacePath | undefined {
  return owner === undefined ? undefined : { root: owner.root, path: [...owner.path, step] };
}

/** A place that stores a value of other places, so it widens with them (see `TypeChecker.#follow`). */
interface Follower {
  readonly place: PlacePath;
  readonly at: SourceSpan;
  /** The places the stored value derives from. */
  readonly origins: Origins;
}

/**
 * Finds the followers whose value derives from a place, in checking order. A follower that an earlier call returned is
 * not returned again, since its place has widened by then. Values copied from each other share groups of origins, and
 * each group is visited once over all calls, not once per follower that holds it, so a long chain of copies costs no
 * more than its length.
 */
function followerFinder(followers: readonly Follower[]): (place: PlacePath) => Follower[] {
  // The followers that hold each group, the groups that merged it, and the groups of one origin by its place.
  const holders = new Map<Origins, number[]>();
  const mergedInto = new Map<Origins, Origins[]>();
  const singles = new Map<Declaration, Map<string, Origins[]>>();
  const seen = new Set<Origins>();
  for (const [index, follower] of followers.entries()) {
    const held = holders.get(follower.origins) ?? [];
    held.push(index);
    holders.set(follower.origins, held);
    const work = [follower.origins];
    while (work.length > 0) {
      const group = work.pop()!;
      if (seen.has(group)) continue;
      seen.add(group);
      if (group.origin !== undefined) {
        const { root, path } = originPlace(group.origin);
        const paths = singles.get(root) ?? new Map<string, Origins[]>();
        const key = path.join(".");
        const groups = paths.get(key) ?? [];
        groups.push(group);
        paths.set(key, groups);
        singles.set(root, paths);
      }
      for (const part of group.parts) {
        const into = mergedInto.get(part) ?? [];
        into.push(group);
        mergedInto.set(part, into);
        work.push(part);
      }
    }
  }
  // A visited group is not visited again: the followers that hold it and every group that merged it were returned then.
  const visited = new Set<Origins>();
  return (place) => {
    const found: number[] = [];
    const work = [...(singles.get(place.root)?.get(place.path.join(".")) ?? [])];
    while (work.length > 0) {
      const group = work.pop()!;
      if (visited.has(group)) continue;
      visited.add(group);
      for (const index of holders.get(group) ?? []) found.push(index);
      for (const merged of mergedInto.get(group) ?? []) work.push(merged);
    }
    found.sort((left, right) => left - right);
    return found.map((index) => followers[index]!);
  };
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
  /** For a parameter, its declaration in the parameter list, which a fix declares another type in. */
  readonly parameter?: FunctionParameter;
  /**
   * Whether a function or a timer or media block may assign it or change its value in place, so a call or suspension
   * cancels its narrowing, or for a change in place only the narrowing that the change can undo.
   */
  readonly shared: Sharing | false;
}

/**
 * Where a fix writes another type for a place: the `let` or `global` of a variable, a parameter in its function's
 * parameter list, or for a property, whose type cannot be written, its first value. `null` for a place without any,
 * such as a loop variable or an element.
 */
type Declared =
  | { readonly kind: "let" | "global"; readonly name: string }
  | { readonly kind: "parameter"; readonly parameter: FunctionParameter }
  | { readonly kind: "property"; readonly label: string }
  | null;

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
  /**
   * For an outcome that no value produces, the tested variable as `never` there, so that the code that cannot run is
   * still checked (rule 1.8) without what the test rules out, such as `x` being null inside `if x != null`.
   */
  readonly unreachedTrue?: Changes;
  readonly unreachedFalse?: Changes;
}

/** The outcomes of a condition's opposite, as of `not`, `!=`, or `is not`. */
function negatedBranches(branches: Branches): Branches {
  return {
    type: BOOLEAN_TYPE,
    whenTrue: branches.whenFalse,
    whenFalse: branches.whenTrue,
    ...(branches.unreachedFalse === undefined ? {} : { unreachedTrue: branches.unreachedFalse }),
    ...(branches.unreachedTrue === undefined ? {} : { unreachedFalse: branches.unreachedTrue }),
  };
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
  /** A declared speaker, with its custom properties as the object of a variable (V30 §37). */
  | { readonly kind: "speaker"; readonly custom: Variable }
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

  /**
   * The names visible here down to `boundary`, not those of `boundary` and the scopes around it, in a new scope under
   * `boundary`: the same variables, so their types stay one.
   */
  public visibleAbove(boundary: Scope): Scope {
    const copy = new Scope(boundary);
    for (let scope: Scope | null = this; scope !== null && scope !== boundary; scope = scope.parent)
      for (const [name, entry] of scope.#entries)
        if (!copy.#entries.has(name)) copy.#entries.set(name, entry);
    return copy;
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
   * that one holds. Only a written union type keeps an `askChoice` of different value types (#511 C2).
   */
  readonly inferred?: "variable" | "part" | undefined;
  /** The source spelling of the place, such as `items` or `door.locked`, when it has one. */
  readonly label: string | null;
  /** Where a fix writes another type for the place, which also decides how a fix for its elements reads. */
  readonly declared?: Declared;
  /** For the elements of a collection, the collection's spelling, so element properties can be named. */
  readonly elementOf?: string | null;
  /** For the elements of a list stored at once, as by `addAll`: a test checks that whole list. */
  readonly listed?: boolean;
  /**
   * For example `'score' holds a whole number (integer)` or `'scores' holds integer values (integer[])`: the type as it
   * is when a message reads it, which a later value may have decided. A copy made by spreading keeps the text of then.
   */
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

  /**
   * The duration of a `wait` or a timer, written after `wait`, `timer`, or `duration:`. Its operator errors suggest
   * grouping before the unit, and a calendar unit after a range is refused like any calendar duration there.
   */
  readonly #timeOperands = new Map<Expression, "wait" | "timer" | "duration:">();

  /** Timer, media, and button blocks to check after their file's functions, with the scope and file they belong to. */
  readonly #handlers: {
    readonly block: Block;
    readonly selfHandle: string | null;
    /** The locals the block shares with the code that created it, under {@link outer} (V30 §14). */
    readonly scope: Scope;
    /** The file's names, or the project's alone. */
    readonly outer: Scope;
    readonly file: number;
  }[] = [];

  #function: FunctionContext | null = null;

  readonly #types = new Map<Expression, StaticType>();

  /** Numbers and durations known at compile time, folded once per expression (see `#known`). */
  readonly #knownValues = new Map<Expression, StaticScalar | undefined>();

  /**
   * Each arithmetic operation that gives a value of unknown type because an operand's type is unknown, with the types it
   * can give, so a place with a written type can tell when none of them could fit it, as `/` never gives text. An
   * operand that is such an operation itself stands for the types it can give, any other operand of unknown type for
   * every type an operator takes.
   */
  readonly #unknownOperations = new Map<Expression, readonly StaticType[]>();

  /**
   * Operations on a variable, element, or property that so far held only null, which fail if it holds only null to the
   * end, and stores into a place whose type a later value may decide: the check reports them once it has checked every
   * store (see {@link #reportDeferred}).
   */
  readonly #deferred: DeferredCheck[] = [];

  /**
   * The property of each property read and the tables of its objects that lacked it, or `null` when a check of the same
   * read found a value it cannot decide for (see {@link #noteMissingProperty}).
   */
  readonly #missingReads = new Map<
    Expression,
    { readonly name: string; readonly tables: PropertyTable[]; readonly named: boolean } | null
  >();

  /** The checked expressions whose kept type is still the type of the place they read. */
  readonly #placeReads = new Set<Expression>();

  /**
   * The values that an assignment or a method changes, such as `items` in `items.add(1)`. A null check names no
   * fallback for them, because what a fallback gives is a copy, so the change would be lost.
   */
  readonly #changed = new WeakSet<Expression>();

  /** The flows at the reachable `break` statements of each enclosing loop, and whether a `continue` is reachable. */
  readonly #loops: { readonly start: FlowState; breaks: Changes[]; continued: boolean }[] = [];

  /** The narrowed types at the current point of the checked code. */
  #flow = new Flow();

  /** What functions, blocks, and loops may change, collected before checking: for the file, and for every loop. */
  #effects: Pick<ProgramEffects, "shared" | "loops"> = { shared: new Map(), loops: new Map() };

  /** The declarations of the variables that a block shares and assigns or changes in place (see {@link VariableSite}). */
  readonly #sharedWrites: ReadonlyMap<VariableSite, Sharing>;

  /** The speaker that each `speaker` names, where a message names it with `as` or its properties use it. */
  readonly #contextualSpeakers: ReadonlyMap<Identifier, string>;

  /** The globals that a function or a timer or media block of any file assigns or changes in place, with how. */
  #sharedGlobals: ReadonlyMap<string, Sharing> = new Map();

  /** Whether the statement being checked can run; a `break` after a `return` does not end its loop. */
  #reachable = true;

  /** The statements that never run, by the flow this check follows. */
  readonly #unreachable = new Set<Statement>();

  /**
   * List and set literals whose elements mix types, with those types. A literal stored in a place of a declared element
   * type is checked element by element instead; every other one is reported at the end of its statement (rule 1.3).
   */
  #mixedLiterals = new Map<Expression, readonly StaticType[]>();
  /** `askChoice` expressions whose buttons return values of different types, which only a declared union may keep. */
  readonly #mixedChoices = new Map<Expression, StaticType>();

  /** The unannotated `let` and `global` statements by initializer, for messages that suggest a declaration. */
  readonly #declaredBy = new Map<Expression, Declared>();

  /**
   * The fields of each `askForm` with the type of the number that decides a field's kind, kept until every type is
   * decided, as for the runtime checks below.
   */
  readonly #forms = new Map<
    InteractionExpression,
    | {
        readonly kind: "object";
        readonly fields: readonly {
          readonly name: string;
          readonly start: StaticType | null;
          readonly answer: StaticType;
        }[];
      }
    | { readonly kind: "dict"; readonly start: StaticType | null; readonly answer: StaticType }
    | { readonly kind: "unknown" }
  >();

  /** Stores of values the compiler cannot know, kept until every type they depend on is decided. */
  readonly #runtimeChecks: {
    readonly site: RuntimeCheckSite;
    readonly place: StaticType;
    readonly label: string;
    /** Whether only the properties of a value of type `object` are unknown, which only a check of properties reads. */
    readonly properties?: true;
  }[] = [];

  /** Whether this check found a variable to widen that earlier checks did not. */
  widenedMore = false;

  /** Whether this check found a place decided after a read that earlier checks did not (see {@link Decided}). */
  decidedMore = false;

  /** Whether this check found a copy of an undecided place that earlier checks did not (see {@link Copies}). */
  copiedMore = false;

  /**
   * Whether this check found a fallback or assignment to keep that earlier checks did not (see {@link KeptFallbacks}).
   */
  keptMore = false;

  readonly #kept: KeptFallbacks;

  /** Whether this check found a custom speaker property that earlier checks did not (see {@link UncheckedProperties}). */
  uncheckedMore = false;

  readonly #unchecked: UncheckedProperties;

  /** For a named speaker's custom property, the names that stores read after it on the way to their targets. */
  readonly #storedThrough = new Map<string, string[]>();

  /** The custom properties of each declared speaker by its name, in the order a session sets the speakers up. */
  readonly #speakerProperties = new Map<string, PropertyTable>();

  /**
   * A table without properties whose sources are the tables of {@link #speakerProperties}, which a read from a speaker
   * that the compiler cannot tell apart reads, so the end of the check visits each speaker's table once for all of them.
   */
  readonly #anySpeaker = new PropertyTable();

  /** A `player.copyFrom(account)` of the project, which gives the player its copied fields from the start. */
  #accountCopy: CallExpression | undefined;

  /**
   * For each declared speaker by its name, the properties that its declaration or an assignment through its name gives
   * it, which decide the reads of its fields of {@link SPEAKER_FIELDS}.
   */
  readonly #speakerGets = new Map<string, Set<string>>();

  /** The reads of speaker fields that this check noted, each once (see {@link #noteSpeakerField}). */
  readonly #fieldReads = new Set<Expression>();

  /** The calls `player.copyFrom(account)` that are statements of their own, the only place the copy may stand. */
  readonly #copyStatements = new WeakSet<Expression>();

  // What the flow check of speaker properties needs (see `speakerFlowInput`): the reads of a property through a
  // speaker's name or `speaker` under `as`, and the stores through a speaker's name; and which ways through each branch,
  // loop, and lazy operand are possible (see `WayFacts`).
  readonly #flowReads = new Map<
    PropertyAccessExpression,
    Omit<SpeakerFlowRead, "sources"> & { readonly file: number }
  >();
  readonly #flowStores = new Map<
    AssignmentStatement,
    SpeakerFlowStore & { readonly file: number }
  >();
  readonly #pathFacts = new Map<Statement, boolean[]>();
  readonly #operandFacts = new Map<string, boolean[]>();

  /** The fallbacks and assignments of this check that replaced places that so far held only null, with those places. */
  readonly #replaced: {
    readonly node: Expression | AssignmentStatement;
    readonly slots: readonly OpenType[];
  }[] = [];

  /**
   * Records the places that a store decided after a read or copy saw them undecided, and for a copy of such a place, the
   * variable it was copied from, which a mismatch in the copy names.
   */
  public recordDecisions(): void {
    const places = new Map<OpenType, PlacePath>();
    for (const [root, variable] of this.#declared)
      for (const { slot, path } of placedSlots(variable.type))
        if (!places.has(slot)) places.set(slot, { root, path });
    const observed = [...places.keys()].filter((slot) => slot.observed === true);
    const copied = [...places.keys()].filter((slot) => slot.copiedFrom !== undefined);
    const { deciding, unknown } = decidingSlots([...observed, ...copied]);
    const undecided = (decider: OpenType): boolean =>
      containsType(decider.resolved!, (part) => part.kind === "open");
    const settled = (decider: OpenType | null | undefined): decider is OpenType =>
      decider !== null && decider !== undefined && !undecided(decider);
    // A decision that still leaves parts undecided, such as `{ images: null }`, is taken over with new slots for them,
    // which the next check decides by its own stores. One that reaches a value that holds itself, such as `a.add(a)`,
    // is not: each next check would find another part to decide.
    const replayable = replayableDecisions();
    for (const slot of observed) {
      const decider = deciding.get(slot);
      // Without a decision, a value the compiler cannot know that reached the slot is replayed instead: it decides
      // nothing, but earlier reads then know that the slot may hold such a value.
      const held = unknown.get(slot);
      const type =
        decider === null || decider === undefined
          ? undefined
          : !undecided(decider)
            ? decider.resolved!
            : replayable(decider)
              ? detachedType(decider.resolved!)
              : undefined;
      const decision: Decision | undefined =
        type !== undefined
          ? { type, at: slot.resolvedAt ?? decider!.resolvedAt! }
          : held !== undefined && decider === null
            ? { type: UNKNOWN_TYPE, at: held }
            : undefined;
      if (decision === undefined) continue;
      const place = places.get(slot)!;
      const paths = this.#decided.get(place.root) ?? new Map<string, Decision>();
      const key = place.path.join(".");
      const recorded = paths.get(key);
      // A decision recorded once is final; only a value the compiler cannot know may give way to a later decision.
      if (
        recorded !== undefined &&
        (recorded.type.kind !== "unknown" || decision.type.kind === "unknown")
      )
        continue;
      paths.set(key, decision);
      this.#decided.set(place.root, paths);
      this.decidedMore = true;
    }
    for (const [slot, place] of places) {
      let source = slot.copiedFrom;
      while (source !== undefined && (places.get(source)?.root ?? place.root) === place.root)
        source = source.copiedFrom;
      // A copy is named after its source only when the source's type does not come from the copy's own first value.
      const decider = source === undefined ? undefined : deciding.get(source);
      if (source === undefined || !settled(decider) || storedIn(slot).has(decider)) continue;
      const copies = this.#copies.get(place.root) ?? new Map<string, string>();
      const key = place.path.join(".");
      const name = declaredName(places.get(source)!.root);
      if (copies.get(key) === name) continue;
      copies.set(key, name);
      this.#copies.set(place.root, copies);
      this.copiedMore = true;
    }
    // A fallback or an assignment replaced a place that held only null where it was checked. When something decided
    // that place after all, also in a way the next check cannot start with, it keeps that place from then on (see
    // `fallbackType`).
    const known = new Map<OpenType, boolean>();
    for (const { node, slots } of this.#replaced)
      if (!this.#kept.has(node) && !slots.every((slot) => heldOnlyNull(slot, known))) {
        this.#kept.add(node);
        this.keptMore = true;
      }
  }

  readonly #decided: Decided;

  readonly #copies: Copies;

  /** For each variable, the paths of {@link #decided} that its type does not have yet, with their steps. */
  readonly #pendingDecisions = new Map<Declaration, Map<string, readonly string[]>>();

  /** Widens every place that follows a widened one (see {@link #followers}). */
  public widenFollowers(): void {
    const pending: PlacePath[] = [];
    for (const [root, paths] of this.#widened)
      for (const path of paths.keys())
        pending.push({ root, path: path === "" ? [] : path.split(".") });
    if (pending.length === 0) return;
    const followersOf = followerFinder(this.#followers);
    while (pending.length > 0) {
      const widened = pending.pop()!;
      for (const { place, at } of followersOf(widened)) {
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
   * The integer places that store a value of other integer places, in checking order, with where: when one of those
   * widens, they widen too, without one more check per step of a chain.
   */
  readonly #followers: Follower[] = [];

  /** The variable each declaration created most recently, whose type later widenings change. */
  readonly #declared = new Map<Declaration, Variable>();

  /**
   * The storage key types that the previous check found from the loads (ADR 0021 §6), which saves must fit, or for the
   * first check, those that the source alone gives (see `storageGuess`).
   */
  readonly #storage: ReadonlyMap<string, StorageKeyType>;

  /**
   * In a check that reads guessed types, the keys whose type it read, each with whether a message named the line of a
   * load of the key, so that the end of the check can tell whether it read the types it found (see {@link readsFound});
   * otherwise `null`.
   */
  readonly #guessedReads: Map<string, boolean> | null;

  /**
   * In a check that reads guessed types, the keys whose type a load without a declared type of its own read, which
   * decides the value it gives (see {@link loadsReadFound}); otherwise `null`.
   */
  readonly #guessedLoads: Set<string> | null;

  /** The loads of storage keys written as string literals that have a type, in checking order. */
  readonly storageLoads: StorageLoad[] = [];

  /**
   * The keys of loads that read their default's type because the previous check found no type for the key. Where another
   * load declares its type, they read that type in the next check, so what this check decided from them may be wrong.
   */
  readonly keysReadAsDefault = new Set<string>();

  /**
   * The declared type of the variable that a `load` starts or is assigned to, which the load reads the stored value as
   * (rule 6.2).
   */
  readonly #loadReceivers = new Map<Expression, StaticType>();

  /** Loads whose default cannot be saved, which a store does not check again. */
  readonly #rejectedDefaults = new Set<Expression>();

  /** Loads that read the type another load of their key declares, which may take more values than their default. */
  readonly #declaredLoads = new Set<Expression>();

  /** One origin for each element or property inside a variable, so equal parts are one origin. */
  readonly #parts = new Map<Declaration, Map<string, PartOrigin>>();

  public constructor(
    options: TypeCheckOptions,
    widened: Widened,
    decided: Decided,
    copies: Copies,
    kept: KeptFallbacks,
    unchecked: UncheckedProperties,
    storage: ReadonlyMap<string, StorageKeyType>,
    guessed: boolean,
    files: number,
    private readonly onFile: (file: number) => void,
    private readonly lines: LineNamer,
  ) {
    this.fileDiagnostics = Array.from({ length: files }, () => []);
    this.#storage = storage;
    this.#guessedReads = guessed ? new Map() : null;
    this.#guessedLoads = guessed ? new Set() : null;
    this.#widened = widened;
    this.#decided = decided;
    this.#copies = copies;
    this.#kept = kept;
    this.#unchecked = unchecked;
    this.#capturesTaggedPhotos = options.capturesTaggedPhotos ?? false;
    this.#sharedWrites = options.sharedWrites ?? new Map();
    this.#contextualSpeakers = options.speakers ?? new Map();
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

  /** Where a fix writes another type for the collection or value that `expression` reads (see {@link Declared}). */
  #declaredOf(expression: Expression, scope: Scope): Declared {
    const node = unwrap(expression);
    if (node.kind === "identifier") {
      const entry = scope.resolve(node.name);
      return entry?.kind === "variable"
        ? variableDeclared(entry.variable, this.#keyword(node.name))
        : null;
    }
    if (node.kind !== "propertyAccessExpression") return null;
    // A person field of the player that a copy of the account gives has the account's type, which no first value
    // changes.
    if (
      this.#accountCopy !== undefined &&
      PERSON_FIELDS.has(node.property.name) &&
      this.#speakerName(node.object, scope) === PLAYER
    )
      return null;
    // Only a property that an object or a speaker keeps has a first value; one that a dict, list, or set computes,
    // such as `keys`, has none.
    const receivers = members(nonNullType(this.#typeOf(node.object))).map(resolved);
    const kept =
      receivers.length > 0 &&
      receivers.every(
        (receiver) =>
          receiver.kind === "object" ||
          (receiver.kind === "speaker" && this.#keepsType(node.property.name)),
      );
    const label = expressionLabel(node);
    return kept && label !== null ? { kind: "property", label } : null;
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
   * `main.tease` first, as a single script (rule 6). `effects` is what its code may change (see `projectEffects`).
   */
  public check(programs: readonly Program[], effects: ProjectEffects): void {
    startPropertyLineage();
    const loops = effects.loops;
    this.#sharedGlobals = effects.sharedGlobals;
    const functionsByFile = programs.map(() => new Map<FunctionDeclaration, FunctionType>());
    for (const [file, program] of programs.entries())
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration" && statement.global)
          functionsByFile[file]!.set(
            statement,
            this.#declareFunction(statement, file, this.#project),
          );
    this.#effects = { shared: new Map(), loops };
    this.#accountCopy = accountCopy(programs);
    // Start values run one after another with nothing between them, so what one stores is known to the next.
    this.#flow = new Flow();
    for (const { file, declaration } of sessionDeclarations(programs)) {
      this.#enterFile(file);
      runCompileTask(this.#startValueTask(declaration));
      this.#reportMixedLiterals();
    }
    // main.tease runs right after the start values, so it starts with what they stored, unless a transfer enters it
    // again later; other files start afresh.
    const startupFlow = effects.files.some((fileEffects) => fileEffects.entersMain)
      ? new Flow()
      : this.#flow;
    for (const [file, program] of programs.entries()) {
      this.#enterFile(file);
      this.#effects = { shared: effects.files[file]!.shared, loops };
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
      runCompileTask(this.#statementsTask(rootStatements, this.#root));
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
        this.#outer = handler.outer;
        // A block does not inherit narrowed facts from the code around it (rule 5.5).
        this.#flow = new Flow();
        runCompileTask(this.#statementsTask(handler.block.statements, scope));
      }
      this.#handlers.length = 0;
    }
    this.#reportDeferred();
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
      this.#rejectRandomSelection(declaration.initial, declaration);
      return;
    }
    // A custom property keeps the type of its first value, as a property of an object (V30 §37), in an object that the
    // declaration stands for, which takes its parts' origins and earlier checks' widenings once it has them all. A
    // built-in property follows its own rules (see `#checkSpeakerProperty`).
    const properties = new PropertyTable();
    const custom: Variable = {
      name: declaration.name.name,
      type: { kind: "object", properties },
      declaration,
      shared: false,
    };
    this.#declared.set(declaration, custom);
    this.#project.declare(declaration.name.name, { kind: "speaker", custom });
    this.#speakerProperties.set(declaration.name.name, properties);
    (this.#anySpeaker.sources ??= new Set()).add(properties);
    const gets = new Set<string>();
    this.#speakerGets.set(declaration.name.name, gets);
    // A copy of the account anywhere, also in a block or function checked later, gives the player each person field,
    // and its terms and name lists text from the start, decided at the copy.
    const copy = declaration === PLAYER_DECLARATION ? this.#accountCopy : undefined;
    if (copy !== undefined)
      for (const name of PERSON_FIELDS) {
        gets.add(name);
        if (this.#keepsType(name))
          properties.set(
            name,
            decidedSlot(
              freshPlaceType(
                SPEAKER_NAME_LISTS.has(name) ? { kind: "list", element: STRING_TYPE } : STRING_TYPE,
              ),
              copy.span,
            ),
          );
      }
    for (const property of declaration.properties) {
      const name = property.name.name;
      gets.add(name);
      if (SPEAKER_PRESENTATION_PROPERTIES.has(name))
        this.diagnostics.push(...presentationPropertyDiagnostics(name, property.value));
      const type = yield* compileChild(this.#expressionTask(property.value, this.#project));
      this.#checkSpeakerProperty(name, property.value, type);
      this.#rejectRandomSelection(property.value, declaration);
      if (!this.#keepsType(name)) continue;
      properties.set(
        name,
        decidedSlot(this.#newPlaceType(property.value, type), property.value.span),
      );
      this.#follow({ root: declaration, path: [name] }, type, property.value.span);
    }
    this.#ownType(declaration, custom.type);
  }

  /** Whether a declared speaker keeps a type for its property `name`: a custom one that no store reaches unchecked. */
  #keepsType(name: string): boolean {
    return !BUILT_IN_SPEAKER_PROPERTIES.has(name) && !this.#unchecked.has(name);
  }

  /**
   * The object of a declared speaker's custom properties when `receiver`, of type `type`, names that speaker and its
   * property `name` keeps a type; a speaker that the compiler cannot tell apart, such as a parameter, has properties of
   * unknown type.
   */
  #customProperties(
    receiver: Expression,
    type: StaticType,
    name: string,
    scope: Scope,
  ): StaticType | undefined {
    const node = unwrap(receiver);
    if (type.kind !== "speaker" || node.kind !== "identifier" || !this.#keepsType(name))
      return undefined;
    const entry = scope.resolve(node.name);
    return entry?.kind === "speaker" ? entry.custom.type : undefined;
  }

  /** The declared speaker that `receiver` names: by its name, or as `speaker` where `as` or its properties name it. */
  #speakerName(receiver: Expression, scope: Scope): string | undefined {
    const node = unwrap(receiver);
    if (node.kind !== "identifier") return undefined;
    const entry = scope.resolve(node.name);
    if (entry?.kind === "speaker") return node.name;
    return entry === undefined ? this.#contextualSpeakers.get(node) : undefined;
  }

  /**
   * Notes the read `read` of a speaker's custom property, also by `+=` or `-=`, whose receiver has the type `receiver`:
   * of the speaker the receiver names, or of any declared speaker when the compiler cannot tell which. When no
   * declaration or assignment gives such a speaker the property, the end of the check reports the read (V30 §37), as
   * one of an object (see {@link #noteMissingProperty}). A property that a store may reach unchecked, and a term that V30
   * gives every speaker, are checked when the script runs (TSR017).
   */
  #noteSpeakerRead(read: PropertyAccessExpression, receiver: StaticType, scope: Scope): void {
    const name = read.property.name;
    if (resolved(receiver).kind !== "speaker") return;
    if (SPEAKER_FIELDS.has(name)) {
      this.#noteSpeakerField(read, scope);
      return;
    }
    if (!this.#keepsType(name)) return;
    const speaker = this.#speakerName(read.object, scope);
    const own = speaker === undefined ? this.#anySpeaker : this.#speakerProperties.get(speaker);
    if (own === undefined) return;
    if (speaker !== undefined)
      this.#flowReads.set(read, {
        speaker,
        name,
        field: false,
        file: this.#file,
        span: read.property.span,
      });
    const example = speaker ?? this.#exampleSpeaker();
    this.#noteMissingIn(
      read,
      name,
      own.has(name) ? null : [own],
      read.property.span,
      (properties) => {
        // A store that the compiler cannot check may give any speaker a property too.
        const custom = [...new Set([...properties, ...this.#unchecked])];
        return missingSpeakerPropertyMessage(
          { speaker: speaker ?? this.#onlySpeaker(), name, sources: [], example },
          { kind: "never", properties: custom, names: [...custom, ...SPEAKER_FIELDS] },
        );
      },
    );
  }

  /**
   * A field of the account (V30 §37): a person field, as text, or a name list, as a list of text. The account may lack
   * it when the script runs, which fails then; an unknown field is an error.
   */
  #accountFieldType(read: PropertyAccessExpression): StaticType {
    const name = read.property.name;
    if (SPEAKER_NAME_LISTS.has(name)) return { kind: "list", element: STRING_TYPE };
    if (PERSON_FIELDS.has(name)) return STRING_TYPE;
    this.#report(
      typeCode.invalidOperand,
      `The account has no field '${name}'.${
        misspelledPropertyHint(name, [...PERSON_FIELDS]) ||
        " Read a person field, as in 'account.firstName', 'account.heShe', or 'account.petNames'."
      }`,
      read.property.span,
    );
    return UNKNOWN_TYPE;
  }

  /**
   * `player.copyFrom(account)`, a statement of its own, copies the account's person fields into the player (V30 §37),
   * so the player gets each of them, which the account may still lack when the script runs, and its terms and name
   * lists hold text (see {@link copyStores}). Any other form of `copyFrom` is an error.
   */
  *#copyFromTask(expression: CallExpression, scope: Scope): CompileTask<StaticType> {
    if (!copiesAccount(expression) || !this.#copyStatements.has(expression)) {
      const callee = unwrap(expression.callee);
      if (callee.kind === "propertyAccessExpression")
        yield* compileChild(this.#expressionTask(callee.object, scope));
      for (const argument of expression.arguments)
        if (!isAccountName(argument.value))
          yield* compileChild(this.#expressionTask(argument.value, scope));
      this.#report(
        typeCode.invalidOperand,
        "'copyFrom' only copies the account into the player: write 'player.copyFrom(account)' on a line of its own.",
        callee.kind === "propertyAccessExpression" ? callee.property.span : expression.span,
      );
      return UNKNOWN_TYPE;
    }
    // The copy is checked as the stores it makes, so it gives the player each field, decides or widens each place, and
    // conflicts with another type that the script gave a field, as such a store would.
    for (const store of copyStores(expression))
      yield* compileChild(this.#assignmentTask(store, scope));
    return NULL_TYPE;
  }

  /**
   * Notes the read `read`, also by `+=` or `-=`, of a field of {@link SPEAKER_FIELDS} from a speaker: of the speaker the
   * receiver names, or of any speaker when the compiler cannot tell which. The end of the check reports it when no
   * declaration or assignment in the project gives such a speaker one of the field's sources (V30 §37).
   */
  #noteSpeakerField(read: PropertyAccessExpression, scope: Scope): void {
    if (this.#fieldReads.has(read)) return;
    this.#fieldReads.add(read);
    const speaker = this.#speakerName(read.object, scope);
    if (speaker !== undefined)
      this.#flowReads.set(read, {
        speaker,
        name: read.property.name,
        field: true,
        file: this.#file,
        span: read.property.span,
      });
    this.#deferred.push({
      kind: "speakerField",
      file: this.#file,
      at: this.diagnostics.length,
      speaker: speaker ?? null,
      name: read.property.name,
      span: read.property.span,
    });
  }

  /** Notes which ways through a branch or loop are possible; a body checked again adds the ways it finds then. */
  #notePaths(statement: Statement, paths: boolean[]): void {
    this.#pathFacts.set(statement, joinedWays(this.#pathFacts.get(statement), paths));
  }

  /** Notes whether the right side of `and`, `or`, or `otherwise` may run, and whether it may be skipped. */
  #noteOperand(expression: Expression, ways: boolean[]): void {
    const key = placeKey(this.#file, expression.span);
    this.#operandFacts.set(key, joinedWays(this.#operandFacts.get(key), ways));
  }

  /**
   * What the flow check of speaker properties needs from the last check (V30 §37). It follows the reads through a
   * speaker's name of a property that a declaration or a store in the package gives the speaker, since the end of the
   * check reports the others, and that no store reaches unchecked, since such a store may give it to any speaker.
   */
  public speakerFlowInput(): SpeakerFlowInput {
    const reads = new Map<string, SpeakerFlowRead>();
    for (const [read, { file, ...flow }] of this.#flowReads) {
      const sources = flow.field ? fieldSources(flow.name) : [flow.name];
      if (sources.some((source) => this.#unchecked.has(source))) continue;
      const given = flow.field
        ? sources.some((source) => this.#speakerGets.get(flow.speaker)?.has(source) === true)
        : this.#speakerProperties.get(flow.speaker)?.has(flow.name) === true;
      if (given) reads.set(placeKey(file, read.span), { ...flow, sources });
    }
    const stores = new Map<string, SpeakerFlowStore>();
    for (const [statement, { file, ...store }] of this.#flowStores)
      stores.set(placeKey(file, statement.target.span), store);
    return { reads, stores };
  }

  /** Which ways through each branch, loop, and lazy operand this check found possible. */
  public ways(): WayFacts {
    return { paths: this.#pathFacts, operands: this.#operandFacts };
  }

  /** The code that this check found never runs, which the loop effects of the next check leave out. */
  public deadCode(): DeadCode {
    const operands = new Set<string>();
    for (const [place, ways] of this.#operandFacts) if (!ways[0]) operands.add(place);
    return { statements: new Set(this.#unreachable), operands };
  }

  /** A declared speaker for a message to name in its example, other than the built-in `player`. */
  #exampleSpeaker(): string {
    for (const name of this.#speakerGets.keys()) if (name !== PLAYER) return name;
    return "name";
  }

  /**
   * The speaker that a read from a speaker the compiler cannot tell apart reaches when the project declares no other
   * one: the built-in `player`, if the project has it.
   */
  #onlySpeaker(): string | null {
    for (const name of this.#speakerGets.keys()) if (name !== PLAYER) return null;
    return this.#speakerGets.has(PLAYER) ? PLAYER : null;
  }

  /**
   * Whether the speaker `speaker`, or some speaker for `null`, gets one of the sources of its field `name`: by its
   * declaration or an assignment through its name, or through a store the compiler cannot check, which may reach any
   * speaker. `anySpeaker` holds what some speaker gets.
   */
  #getsField(speaker: string | null, name: string, anySpeaker: ReadonlySet<string>): boolean {
    const gets = speaker === null ? anySpeaker : this.#speakerGets.get(speaker);
    return fieldSources(name).some(
      (source) => this.#unchecked.has(source) || gets?.has(source) === true,
    );
  }

  /**
   * Notes the custom speaker properties that a store into `target`, or an element added to it, may reach unchecked:
   * a property read from a value that may be a speaker the compiler cannot tell apart, or of unknown type, on the way
   * to `target` (see {@link UncheckedProperties}).
   */
  #noteUncheckedStore(target: Expression, scope: Scope): void {
    const named = (node: Expression): boolean =>
      node.kind === "identifier" && scope.resolve(node.name)?.kind === "speaker";
    // The property names read on the way, from the target back to where the way starts.
    const names: string[] = [];
    let node = unwrap(target);
    for (;;) {
      if (node.kind === "propertyAccessExpression") {
        const receiver = unwrap(node.object);
        names.push(node.property.name);
        if (!named(receiver) && mayBe(this.#typeOf(receiver), "speaker"))
          this.#markUnchecked(node.property.name);
        node = receiver;
      } else if (node.kind === "indexExpression") node = unwrap(node.object);
      else break;
    }
    // A named speaker's property that keeps no type may hold any speaker, so the names read after it are reached too.
    // Its read gave them that reason above; one that loses its type later in this check gives it to them then.
    if (!named(node) || names.length < 2) return;
    const [first, ...later] = names.reverse();
    if (!this.#keepsType(first!)) return;
    const through = this.#storedThrough.get(first!) ?? [];
    for (const name of later) through.push(name);
    this.#storedThrough.set(first!, through);
  }

  /** Adds `name` to the custom speaker properties that keep no type, with the names stored through it on the way. */
  #markUnchecked(name: string): void {
    const work = [name];
    for (let next = work.pop(); next !== undefined; next = work.pop()) {
      if (this.#unchecked.has(next)) continue;
      this.#unchecked.add(next);
      this.uncheckedMore = true;
      for (const later of this.#storedThrough.get(next) ?? []) work.push(later);
    }
  }

  /**
   * Reports a start value that would select a random element: a list shown in `${...}`, or `.random`. A start value is
   * set up before the story runs and uses no random numbers (ADR 0022 §6); the runtime rejects a value of unknown type.
   */
  #rejectRandomSelection(value: Expression, owner: GlobalStatement | SpeakerDeclaration): void {
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
          startValueMessage(owner, { kind: "random" }),
          expression.span,
        );
      if (expression.kind === "stringLiteral")
        for (const part of expression.parts)
          if (part.kind === "stringInterpolation" && this.#mayBe(part.expression, isList))
            this.#report(
              typeCode.randomStartValue,
              startValueMessage(owner, { kind: "shownList" }),
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
  /** The result shape of each `askForm`, with whether each numeric field is an integer or a number field. */
  public formShapes(): ReadonlyMap<InteractionExpression, PreparedFormShape> {
    const shapes = new Map<InteractionExpression, PreparedFormShape>();
    const numericKind = (start: StaticType | null): FormNumericKind | null => {
      const type = start === null ? null : resolved(nonNullType(start));
      return type === null
        ? null
        : isScalar(type, "integer")
          ? "integer"
          : isScalar(type, "number")
            ? "number"
            : null;
    };
    for (const [expression, form] of this.#forms) {
      if (form.kind === "unknown") {
        shapes.set(expression, form);
        continue;
      }
      if (form.kind === "dict") {
        shapes.set(expression, {
          kind: "dict",
          numericKind: numericKind(form.start),
          answer: typePlan(form.answer),
        });
        continue;
      }
      const numericKinds: { readonly name: string; readonly numericKind: FormNumericKind }[] = [];
      const answers: { readonly name: string; readonly type: TypePlan }[] = [];
      for (const { name, start, answer } of form.fields) {
        const kind = numericKind(start);
        if (kind !== null) numericKinds.push({ name, numericKind: kind });
        // The form checks when it opens that each field answers within the type given here.
        const checked = typePlan(answer);
        if (checked !== null) answers.push({ name, type: checked });
      }
      shapes.set(expression, { kind: "object", numericKinds, answers });
    }
    return shapes;
  }

  public runtimeChecks(): ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> {
    const checks = new Map<RuntimeCheckSite, TypeCheckPlan>();
    for (const check of this.#runtimeChecks) {
      const type = typePlan(check.place);
      if (type !== null && (check.properties === undefined || checksProperties(type)))
        checks.set(check.site, { type, place: check.label });
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
      if (!this.#reachable) this.#unreachable.add(statement);
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
        if (copiesAccount(statement.expression)) this.#copyStatements.add(statement.expression);
        yield* compileChild(this.#expressionTask(statement.expression, scope));
        this.#reportCopyChangedInPlace(statement.expression);
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
        yield* compileChild(this.#timeTask(statement.duration, "wait", statement.unit, scope));
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
      case "stopAudioStatement":
        this.#suspend();
        return true;
      case "showPopupStatement":
        yield* compileChild(this.#showPopupTask(statement, scope));
        // The popup waits until the player closes it.
        this.#suspend();
        return true;
      case "openUrlStatement":
        yield* compileChild(this.#openUrlTask(statement, scope));
        this.#suspend();
        return true;
      case "exportTextStatement":
        yield* compileChild(this.#exportTextTask(statement, scope));
        // The dialog waits until the player closes it.
        this.#suspend();
        return true;
      case "saveStatement": {
        const value = yield* compileChild(this.#expressionTask(statement.value, scope));
        const unsaveable = holdsSessionValue(value);
        if (unsaveable)
          this.#report(
            typeCode.invalidOperand,
            `${SESSION_VALUES} cannot be saved, but this is ${describeValue(value)}.${containsType(value, (part) => part.kind === "messageHandle") ? " Save a message's text with its text property, as in 'save line.text as \"status\"'." : ""}`,
            statement.value.span,
          );
        yield* compileChild(this.#storageKeyTask(statement.key, scope));
        if (!unsaveable)
          yield* compileChild(this.#savedValueTask(statement.key, statement.value, value));
        this.#suspend();
        return true;
      }
      case "deleteStatement":
        yield* compileChild(this.#storageKeyTask(statement.key, scope));
        this.#suspend();
        return true;
      case "ifStatement": {
        const condition = yield* compileChild(this.#conditionTask(statement.condition, scope));
        this.#notePaths(statement, [condition.whenTrue !== null, condition.whenFalse !== null]);
        const start = this.#flow.mark();
        this.#flow.apply(condition.whenTrue ?? condition.unreachedTrue ?? null);
        const thenContinues = yield* compileChild(
          this.#pathTask(statement.thenBlock, scope, condition.whenTrue !== null),
        );
        const thenEnd = this.#flow.mark();
        this.#flow.restore(start);
        this.#flow.apply(condition.whenFalse ?? condition.unreachedFalse ?? null);
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
        const casePaths: boolean[] = [];
        // The literal values that the value cases list, to tell whether they take every value the subject can hold.
        const literals: PossibleValue[] = [];
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
              if (never === undefined) {
                matchable = true;
                if (literalRange(value) === undefined)
                  literals.push(...(comparedLiteral(value) ?? []));
              } else
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
          casePaths.push(reached);
          if ((yield* compileChild(this.#pathTask(switchCase.body, scope, reached))) && reached)
            ends.push(this.#flow.mark());
        }
        // `default`, or the path without one, runs when no case matched: not when no value is left, also because the
        // cases list every value it can be. A path that no value reaches does not continue.
        this.#flow.restore(start);
        const restReached = remaining.kind !== "never" && !takesEveryValue(remaining, literals);
        this.#notePaths(statement, [...casePaths, restReached]);
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
        this.#notePaths(statement, [condition.whenTrue !== null, condition.whenFalse !== null]);
        const start = this.#flow.mark();
        this.#flow.apply(condition.whenTrue ?? condition.unreachedTrue ?? null);
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
        const known = this.#known(statement.count);
        if (isScalar(count, "number"))
          this.#report(
            typeCode.invalidRepeatCount,
            repeatCountMessage(
              "this",
              describeValue(count),
              `${this.#widenedNote(statement.count)}${ROUND_COUNT_FIX}`,
            ),
            statement.count.span,
          );
        else if (typeof known === "number" && !isRepeatCount(known))
          this.#report(
            typeCode.invalidRepeatCount,
            repeatCountMessage("this", describeShownValue(known), repeatCountFix(known)),
            statement.count.span,
          );
        else
          this.#reportUnless(
            counted,
            (member) => isScalar(member, "integer"),
            statement.count,
            REPEAT_COUNT_RULE,
            undefined,
            typeCode.invalidRepeatCount,
          );
        const times = staticNumber(statement.count);
        this.#notePaths(statement, [
          times === undefined || times >= 1,
          times === undefined || times < 1,
        ]);
        const ends = yield* compileChild(
          this.#loopBodyTask(statement.body, scope, [], times === undefined || times >= 1),
        );
        // A loop that certainly runs once ends normally only when its body or a `break` does.
        return times === undefined || times < 1 || ends;
      }
      case "forStatement": {
        const iterable = yield* compileChild(this.#expressionTask(statement.iterable, scope));
        if (statement.valueVariable !== null)
          return yield* compileChild(
            this.#pairLoopTask(statement, statement.valueVariable, iterable, scope),
          );
        this.#checkWholeRangeBounds(statement.iterable, "A 'for' loop");
        this.#warnEmptyRange(statement.iterable, "the loop never runs");
        // A loop over a dict goes through its keys.
        const element = elementType(iterable, true);
        this.#reportUnless(
          iterable,
          (member) => elementType(member, true) !== undefined,
          statement.iterable,
          FOR_SOURCE_RULE,
          undefined,
          typeCode.invalidLoopSource,
        );
        const loopType = element === undefined ? UNKNOWN_TYPE : loopValueType(element);
        this.#follow({ root: statement, path: [] }, loopType, statement.iterable.span);
        const variable: Variable = {
          name: statement.variable.name,
          type: this.#ownType(statement, loopType),
          shared: this.#sharedLocal(statement),
          declaration: statement,
        };
        this.#declared.set(statement, variable);
        this.#notePaths(statement, [
          !isEmptyLiteral(statement.iterable),
          !isNonEmptyLiteral(statement.iterable),
        ]);
        const ends = yield* compileChild(
          this.#loopBodyTask(
            statement.body,
            scope,
            [variable],
            !isEmptyLiteral(statement.iterable),
          ),
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
    if (block.kind !== "block" && !this.#reachable) this.#unreachable.add(block);
    const continues =
      block.kind === "block"
        ? yield* compileChild(this.#blockTask(block, scope))
        : yield* compileChild(this.#statementTask(block, scope));
    this.#reachable = reachable;
    return continues;
  }

  /**
   * `for key, value in dict`: the key is text, and the value a variable of its own with the dict's value type, so each
   * keeps its own type and widening.
   */
  *#pairLoopTask(
    statement: ForStatement,
    valueName: Identifier,
    iterable: StaticType,
    scope: Scope,
  ): CompileTask<boolean> {
    this.#reportUnless(
      iterable,
      (member) => dictValueType(member) !== undefined,
      statement.iterable,
      pairLoopRule(statement.variable.name, valueName.name),
      undefined,
      typeCode.invalidLoopSource,
    );
    const key: Variable = {
      name: statement.variable.name,
      type: this.#ownType(statement, copyType(STRING_TYPE)),
      shared: this.#sharedLocal(statement),
      declaration: statement,
    };
    const element = dictValueType(iterable);
    const valueType = element === undefined ? UNKNOWN_TYPE : loopValueType(element);
    this.#follow({ root: valueName, path: [] }, valueType, statement.iterable.span);
    const value: Variable = {
      name: valueName.name,
      type: this.#ownType(valueName, valueType),
      shared: this.#sharedLocal(valueName),
      declaration: valueName,
    };
    this.#declared.set(statement, key);
    this.#declared.set(valueName, value);
    this.#notePaths(statement, [
      !isEmptyLiteral(statement.iterable),
      !isNonEmptyLiteral(statement.iterable),
    ]);
    const ends = yield* compileChild(
      this.#loopBodyTask(statement.body, scope, [key, value], !isEmptyLiteral(statement.iterable)),
    );
    return !isNonEmptyLiteral(statement.iterable) || ends;
  }

  /**
   * The body of a `repeat` or `for` loop, which may run any number of times, including none. Returns whether the body
   * can end normally or leave through a `break`. A body that certainly runs no time is checked, but nothing in it can
   * be reached.
   */
  *#loopBodyTask(
    body: Block,
    scope: Scope,
    variables: readonly Variable[],
    reached: boolean,
  ): CompileTask<boolean> {
    const reachable = this.#reachable;
    if (!reached) this.#reachable = false;
    this.#widen(body);
    const start = this.#flow.mark();
    const loopScope = new Scope(scope);
    for (const variable of variables)
      loopScope.declare(variable.name, { kind: "variable", variable });
    this.#loops.push({ start, breaks: [], continued: false });
    const continues = yield* compileChild(this.#statementsTask(body.statements, loopScope));
    const { breaks, continued } = this.#loops.pop()!;
    this.#flow.restore(start);
    // The body may also run no time at all.
    this.#flow.apply(this.#flow.join([new Map(), ...breaks]));
    this.#reachable = reachable;
    return continues || continued || breaks.length > 0;
  }

  *#sayTask(statement: SayParts, scope: Scope): CompileTask<void> {
    if (statement.presentation !== null) {
      yield* compileChild(this.#expressionTask(statement.presentation, scope));
      this.#checkPresentation(statement.presentation);
    }
    this.diagnostics.push(...messageColorDiagnostics(statement.value));
    yield* compileChild(this.#expressionTask(statement.value, scope));
    if (statement.pacing !== null && statement.pacing !== "instant") {
      const pacing = statement.pacing;
      const type = yield* compileChild(this.#expressionTask(pacing, scope));
      this.#reportNonDuration(pacing, type, "Say pacing is a duration or instant", "3 s", () =>
        unitFix(pacing),
      );
      const known = this.#knownLength(pacing);
      if (known !== undefined && !isDelayLength(known.milliseconds))
        this.#report(
          typeCode.invalidRepeatCount,
          pacingMessage(formatDuration(known)),
          pacing.span,
        );
    }
  }

  /**
   * The options of a message mode written for a `say` or an ask's question, such as `prose(align: "center")`, whose
   * known values must name a colour, an alignment, or a mode; a value the compiler cannot know falls back when shown.
   */
  #checkPresentation(presentation: ObjectLiteral | null): void {
    if (presentation === null) return;
    for (const property of presentation.properties)
      this.diagnostics.push(...presentationPropertyDiagnostics(property.name.name, property.value));
  }

  /** A `let`, or the start value of a `global`, which declares the global in the project's names. */
  *#letTask(statement: LetStatement | GlobalStatement, scope: Scope): CompileTask<void> {
    const name = statement.name.name;
    const keyword = statement.kind === "letStatement" ? "let" : "global";
    const written = statement.kind === "letStatement" ? statement.initializer : statement.initial;
    const initializer = unwrap(written);
    const declaration: Declared = { kind: keyword, name };
    if (statement.typeAnnotation === null) this.#declaredBy.set(initializer, declaration);
    const declared =
      statement.typeAnnotation === null ? null : this.#annotationType(statement.typeAnnotation);
    if (declared !== null && initializer.kind === "loadExpression")
      this.#loadReceivers.set(initializer, declared);
    let value =
      initializer.kind === "playMediaExpression"
        ? yield* compileChild(this.#mediaTask(initializer, scope, name))
        : yield* compileChild(this.#expressionTask(written, scope));
    let type: StaticType;
    if (statement.typeAnnotation === null) {
      // A read of a place that held only values the compiler cannot know gives such a value (rule 1.7).
      if (readsHeldUnknown(value)) value = UNKNOWN_TYPE;
      type = this.#newPlaceType(written, value);
      // A copy of a place that took null keeps that null as a member, which a null check removes; only a copy belongs
      // to this variable alone.
      if (this.#placeReads.has(written)) type = ownNull(type);
      // A number this variable holds derives from the variable itself, which follows what its first value derives
      // from (rule 1.2).
      this.#follow({ root: statement, path: [] }, value, written.span);
      type = this.#ownType(statement, type);
      this.#reportMixedChoice(
        written,
        (type) =>
          `to keep both, declare a union type, as in '${keyword} ${name}: ${type} = askChoice ...'`,
      );
    } else {
      type = declared!;
      const place: Place = {
        type,
        label: name,
        declared: declaration,
        subject: `'${name}' is declared as ${typeName(type)}`,
        verb: "start as",
        fix: (rejected, expression) => typeFix(declaration, type, rejected, expression),
      };
      const checked = this.#checkedValue(written);
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
          ? (this.#sharedGlobals.get(name) ?? false)
          : scope === this.#root
            ? (this.#effects.shared.get(name) ?? false)
            : this.#sharedLocal(statement),
      declaration: statement.typeAnnotation === null ? statement : undefined,
      annotated: statement.typeAnnotation !== null,
    };
    if (statement.typeAnnotation === null) this.#declared.set(statement, variable);
    scope.declare(name, { kind: "variable", variable });
    this.#assigned(variable, value);
  }

  /**
   * Whether a timer, media, or button block shares and assigns the variable of this declaration or changes it in place,
   * so that a suspension may change it (rule 5.5, V30 §14).
   */
  #sharedLocal(site: VariableSite): Sharing | false {
    return this.#sharedWrites.get(site) ?? false;
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
   * that they may assign, or that a change they may make in place may undo (rule 5.5).
   */
  #suspend(): void {
    this.#flow.forgetShared((variable, type) => undoneBy(variable, type, variable.shared));
  }

  /** At the start of a loop: forget what its body (or a call or suspension in it) may change on an earlier iteration. */
  #widen(body: Block): void {
    const effects = this.#effects.loops.get(body) ?? { writes: new Map(), suspends: true };
    this.#flow.forget((variable, type) => {
      const written = effects.writes.get(variable.name) ?? false;
      const shared = effects.suspends ? variable.shared : false;
      const how = written === "assigns" || shared === "assigns" ? "assigns" : written || shared;
      return undoneBy(variable, type, how);
    });
  }

  /**
   * A camera view's placement, a timer's display, or a media volume that the compiler knows to be wrong, written to what
   * can only be such a handle, also through an alias, a parameter, a function result, or a collection element. A value
   * of another type is a type error of the store, and a value the compiler cannot know is checked at runtime (`TSR050`).
   */
  #checkHandleValue(
    object: StaticType,
    name: string,
    statement: AssignmentStatement,
    value: StaticType,
  ): void {
    const receivers = members(nonNullType(object)).map((member) => resolved(member).kind);
    const kind = receivers[0];
    if (kind === undefined || receivers.some((other) => other !== kind)) return;
    const report = (message: string) =>
      this.#report(handleMemberCode(kind), message, statement.value.span);
    const text = isScalar(value, "string") ? staticVisibleText(statement.value) : undefined;
    if (kind === "camera" && name === "placement") {
      // Adding text to the placement never gives another placement; any other change is the operation's error.
      if (statement.operator !== "=") {
        if (
          statement.operator === "+=" &&
          (isScalar(value, "string") || !isKnown(nonNullTypeForUse(value)))
        )
          report(cameraPlacementMessage(null));
      } else if (text !== undefined && !isCameraPlacement(text))
        report(cameraPlacementMessage(shownChoice(text)));
    } else if (statement.operator !== "=") return;
    else if (kind === "timer" && name === "display") {
      if (text !== undefined && !isTimerDisplay(text))
        report(timerDisplayMessage(shownChoice(text)));
    } else if (kind === "media" && name === "volume") {
      const known = this.#known(statement.value);
      if (typeof known === "number" && !isMediaVolume(known))
        report(mediaVolumeMessage(describeShownValue(known)));
    }
  }

  /**
   * The markup colours of literal text written to what can only be a message handle, checked as `say` checks its text;
   * text the compiler cannot know falls back when it is shown.
   */
  #checkMessageText(object: StaticType, statement: AssignmentStatement): void {
    const receivers = members(nonNullType(object));
    if (
      receivers.length > 0 &&
      receivers.every((member) => resolved(member).kind === "messageHandle")
    )
      this.diagnostics.push(...messageColorDiagnostics(statement.value));
  }

  *#assignmentTask(statement: AssignmentStatement, scope: Scope): CompileTask<void> {
    const target = statement.target;
    let place: Place | undefined;
    let variable: Variable | undefined;
    let handle = false;
    /** The check of the value written to a handle property, once the value's type is known. */
    let checkValue: ((value: StaticType) => void) | undefined;
    /** For an element, the type it may hold now, which can be wider than what may be stored. */
    let read: StaticType | undefined;
    /** The name of a speaker property the store may write, which the runtime checks. */
    let speakerProperty: string | null = null;
    /** A property without a static type, such as one of an `object` or of a value of unknown type. */
    let untyped = false;
    // A null check names no fallback for the target or a value it is part of, as `p` in `p.name = "Bo"` or `n += 1`.
    this.#noteChanged(target);
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
      this.#reportChangedCopy(target, target.object);
      this.#noteUncheckedStore(target, scope);
      if (target.kind === "indexExpression") {
        const index = yield* compileChild(this.#expressionTask(target.index, scope));
        this.#checkIndex(object, target.object, index, target.index);
        if (statement.operator === "=") {
          const value = yield* compileChild(this.#expressionTask(statement.value, scope));
          const receiver = this.#elementReceiver(target.object, scope, object, value);
          const checked = this.#checkedValue(statement.value);
          yield* compileChild(
            this.#storeElementTask(
              receiver,
              target.object,
              checked,
              checked === statement.value ? value : this.#typeOf(checked),
              scope,
            ),
          );
          // The store checks a load's default, but stores the loaded value (see `#storeLoaded`).
          if (checked !== statement.value)
            for (const member of members(nonNullType(receiver)).map(resolved))
              if (isCollection(member)) this.#storeLoaded(member.element, value, statement.value);
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
            this.#declaredOf(target.object, scope),
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
        const name = target.property.name;
        if (statement.operator !== "=") this.#noteSpeakerRead(target, object, scope);
        else {
          // A store through a speaker's name gives it the property; any other store into a speaker is unchecked.
          const speaker = this.#speakerName(target.object, scope);
          if (speaker !== undefined) {
            this.#speakerGets.get(speaker)?.add(name);
            this.#flowStores.set(statement, { speaker, name, file: this.#file });
          }
        }
        const custom = this.#customProperties(target.object, object, name, scope);
        const receiver = custom ?? object;
        const value = resolved(nonNullType(receiver));
        // A new property takes its type from its first value, by the same rule as `let` (rule 1.4).
        if (value.kind === "object" && value.properties !== null && !value.properties.has(name)) {
          // A receiver that may be null needs a check first, also for a new property (owner decision on #504 Q1).
          const receivers = members(receiver);
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
            const added = decidedSlot(
              this.#newPlaceType(statement.value, assigned),
              statement.value.span,
            );
            value.properties.set(name, added);
            const owner = this.#pathOf(target.object, scope);
            if (owner !== undefined) {
              this.#follow(extendPath(owner, name), assigned, statement.value.span);
              this.#rewiden(owner.root, { path: [...owner.path, name], part: added });
            }
          }
          // `+=` and `-=` read the property first; a speaker's is noted above.
          else if (custom === undefined) this.#noteMissingAccess(target, receiver);
          return;
        }
        const before = this.diagnostics.length;
        place = this.#propertyPlace(receiver, target.object, target.property, scope);
        const speakers = members(nonNullType(receiver)).map(
          (member) => resolved(member).kind === "speaker",
        );
        if (speakers.includes(true)) speakerProperty = name;
        // A speaker shows its text property; any other receiver keeps the value as it is.
        untyped =
          place === undefined && this.diagnostics.length === before && speakers.includes(false);
        handle = mayBe(receiver, "timer", "media", "camera");
        // A media position, remaining time, or volume write, and a camera view's placement, first wait for the
        // previous message's pacing.
        if (MEDIA_PACED_PROPERTIES.has(name) && mayBe(receiver, "media")) this.#suspend();
        if (name === "placement" && mayBe(receiver, "camera")) this.#suspend();
        if (handle)
          checkValue = (value) => this.#checkHandleValue(receiver, name, statement, value);
        if (name === "text" && statement.operator === "=")
          this.#checkMessageText(receiver, statement);
      }
    }
    const loaded = unwrap(statement.value);
    if (
      statement.operator === "=" &&
      variable?.annotated === true &&
      loaded.kind === "loadExpression"
    )
      this.#loadReceivers.set(loaded, variable.type);
    // What the variable holds where it is read, before a call in the value may end what is known about it.
    const before = variable === undefined ? undefined : this.#currentType(variable);
    const value = yield* compileChild(this.#expressionTask(statement.value, scope));
    checkValue?.(value);
    // A mixed `askChoice` that C2 rejects for the other receivers needs no second message here.
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
      const own =
        variable === undefined ? undefined : this.#ownFallback(statement.value, variable, scope);
      if (own !== undefined) {
        yield* compileChild(this.#storeTask(place, own.expression, own.type));
        // Where it was not null, the variable keeps the value it held, of the type the store may just have decided.
        this.#assigned(variable!, union([nonNullType(before!), own.type]));
        return;
      }
      const checked = this.#checkedValue(statement.value);
      yield* compileChild(
        this.#storeTask(
          place,
          checked,
          checked === statement.value ? value : this.#typeOf(checked),
        ),
      );
      // The store checks a load's default, but stores the loaded value (see `#storeLoaded`).
      if (checked !== statement.value) this.#storeLoaded(place.type, value, statement.value);
      // A variable of unknown type may take the value's own type, so it gets a copy of a place it was read from.
      if (variable !== undefined) {
        let held = this.#capture(statement.value);
        // A copy of a place that so far held only null, such as an element of `[null]`, is null here, as for
        // `otherwise` (see `fallbackType`): no store into a variable of unknown type decides the copy, as after `let`.
        const slot = resolved(variable.type).kind === "unknown" ? nullOnlySlot(held) : undefined;
        if (slot !== undefined && !this.#kept.has(statement)) {
          this.#replaced.push({ node: statement, slots: [slot] });
          held = NULL_TYPE;
        }
        this.#assigned(variable, held);
      }
      return;
    }
    const operator = statement.operator === "+=" ? "+" : "-";
    // `+=` and `-=` read the variable before the value runs (V30 §14).
    const kept = resolved(read ?? before ?? place.type);
    if (variable !== undefined) this.#flow.set(variable, undefined);
    const reported = this.diagnostics.length;
    const combine = (a: StaticType, b: StaticType) => arithmeticType(operator, a, b);
    const cannotCombine = (held: StaticType, added: StaticType) =>
      `${place.subject}, so ${describeValue(added)} cannot be ${operator === "+" ? "added to" : "subtracted from"} ${place.verb === "contain" ? "an element" : "it"}.${this.#copyNote(place.widening, place.type)}${operandFix(nonNullType(held), added, statement)}`;
    // Adding or subtracting null is never supported.
    const outcome =
      resolved(nonNullType(value)).kind === "never"
        ? { failed: [kept, value] }
        : this.#memberOperation([kept, value], [target, statement.value], combine);
    const result = "type" in outcome ? outcome.type : undefined;
    if (result !== undefined && isScalar(value, "calendarDuration"))
      this.#checkLocalCalendarOffset(kept, statement.value, statement.value.span);
    if (result !== undefined && !isKnown(result)) {
      this.#checkUnknownCompound(place, kept, statement);
      // A place or a value that so far held only null is checked as null too, in case no store gives it another value.
      const slots =
        this.diagnostics.length === reported
          ? [kept, value].flatMap((operand) => nullOnlySlot(operand) ?? [])
          : [];
      if (slots.length > 0) {
        const held = nullOnlySlot(kept) === undefined ? kept : NULL_TYPE;
        const added = nullOnlySlot(value) === undefined ? value : NULL_TYPE;
        this.#deferNullOnly(slots, () => {
          if (
            resolved(nonNullType(added)).kind === "never" ||
            "failed" in this.#memberOperation([held, added], [target, statement.value], combine)
          )
            this.#report(typeCode.typeMismatch, cannotCombine(held, added), statement.value.span);
        });
      }
      return;
    }
    if (result === undefined) {
      const [first, second] = [resolved(kept), resolved(value)];
      if (operator === "+" && first.kind === "list" && second.kind === "list") {
        this.#reportMixedJoin(
          "'+='",
          "list",
          first.element,
          second.element,
          place.declared ?? null,
          statement.value.span,
          this.#copyNote(extendPath(place.widening, "[]"), first.element),
        );
        return;
      }
      const subject = place.subject;
      // A date and time moves by elapsed time only through an absolute date and time (ADR 0026).
      if (isScalar(nonNullType(kept), "datetime") && isScalar(value, "duration")) {
        const label = expressionLabel(target) ?? "value";
        this.#report(
          typeCode.typeMismatch,
          `${subject}, which has no time zone, so it cannot move by elapsed time. Use calendar units, such as '1 calendar day', or write '${label} = (${label}.toAbsoluteDateTime() ${operator} ${durationText(statement.value)}).toDateTime()'.`,
          statement.value.span,
        );
        return;
      }
      this.#report(typeCode.typeMismatch, cannotCombine(kept, value), statement.value.span);
      return;
    }
    if (this.#widens(place, result, statement.value)) return;
    this.#follow(place.widening, result, statement.value.span);
    if (!isAssignable(place.type, result))
      this.#report(
        typeCode.typeMismatch,
        `${place.subject}, so '${statement.operator}' cannot make ${place.verb === "contain" ? "an element" : "it"} ${describeValue(result)}.${this.#copyNote(place.widening, place.type)}${place.fix(result, null)}`,
        statement.value.span,
      );
    else {
      // A joined list decides an element type that no value decided yet, as a store does.
      if (isCollection(resolved(result))) {
        settle(place.type, result, statement.value.span);
        if (place.widening !== undefined)
          this.#rewiden(place.widening.root, { path: place.widening.path, part: place.type });
      }
      if (variable !== undefined) this.#assigned(variable, result);
    }
  }

  /**
   * Reports `+=` or `-=` with an operation of unknown result when no type that operation can give, added to or
   * subtracted from any type the place may hold, could fit the place's type, as text never comes from `/`.
   */
  #checkUnknownCompound(place: Place, kept: StaticType, statement: AssignmentStatement): void {
    const operation = unwrap(statement.value);
    const given = this.#unknownOperations.get(operation);
    const held = members(resolved(nonNullType(kept)));
    if (
      given === undefined ||
      given.length === 0 ||
      (operation.kind !== "binaryExpression" && operation.kind !== "unaryExpression") ||
      !held.every(isKnown)
    )
      return;
    const operator = statement.operator === "+=" ? "+" : "-";
    const fits = held.some((member) =>
      given.some((type) => {
        const result = arithmeticType(operator, member, type);
        return result !== undefined && mayFit(place.type, result);
      }),
    );
    if (fits) return;
    const results = union([...given]);
    const text = operationText(statement.value);
    const target = expressionLabel(statement.target);
    const fix =
      operator === "+" && held.some((member) => isScalar(member, "string"))
        ? text === null || target === null
          ? ' Put the whole calculation inside "${" and "}" instead.'
          : ` Put the result in the text instead, as in '${target} += "\${${text}}"'.`
        : operandFix(nonNullType(kept), results, statement);
    this.#report(
      typeCode.typeMismatch,
      `${place.subject}, so the result of '${operation.operator}', which is ${describeValue(results)}, cannot be ${operator === "+" ? "added to" : "subtracted from"} ${place.verb === "contain" ? "an element" : "it"}.${fix}`,
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
      // An element that an operation of unknown result gives, which the elements of no member could hold, cannot fit,
      // also inside nested literals, against what the members' elements hold at that depth.
      if (candidates.length > 1) {
        const pending: {
          readonly literal: Extract<
            Expression,
            { kind: "listLiteral" | "setLiteral" | "dictLiteral" }
          >;
          readonly holders: StaticType[];
        }[] = [{ literal, holders: candidates.map((candidate) => candidate.element) }];
        for (let next = 0; next < pending.length; next += 1) {
          const { literal: current, holders } = pending[next]!;
          const held = holders.flatMap((holder) =>
            members(resolved(nonNullType(holder))).map(resolved),
          );
          // A holder of values the compiler cannot know, such as `list`, may hold anything below it. Null holds none.
          if (held.some((member) => member.kind === "unknown" || member.kind === "open")) continue;
          for (const element of literalElements(current)) {
            const nested = unwrap(element);
            if (
              nested.kind === "listLiteral" ||
              nested.kind === "setLiteral" ||
              nested.kind === "dictLiteral"
            ) {
              const kind = literalCollectionKind(nested);
              const inner = held
                .filter((member): member is CollectionType => member.kind === kind)
                .map((member) => member.element);
              if (inner.length > 0) pending.push({ literal: nested, holders: inner });
              continue;
            }
            // Each holder is tested on its own: a union of them would compare the deeper levels again at every depth.
            if (
              (nested.kind !== "binaryExpression" && nested.kind !== "unaryExpression") ||
              isKnown(this.#typeOf(element))
            )
              continue;
            const results = this.#unknownOperations.get(nested);
            if (
              results === undefined ||
              results.length === 0 ||
              results.some((result) => held.some((member) => mayFit(member, result)))
            )
              continue;
            const text = operationText(element);
            this.#report(
              typeCode.typeMismatch,
              `${place.subject}, so it cannot contain the result of '${nested.operator}', which is ${describeValue(union([...results]))}.${held.some((member) => isScalar(member, "string")) ? (text === null ? ' To show it as text, put the whole calculation inside "${" and "}".' : ` To show it as text, write "\${${text}}".`) : place.label === null ? " Change its type so its elements can hold that result." : ` Change the type of '${place.label}' so its elements can hold that result.`}`,
              element.span,
            );
            return;
          }
        }
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
        place.declared ?? null,
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
        this.#rewiden(place.widening.root, { path: place.widening.path, part: place.type });
      return;
    }
    if (this.#reportUnfit(place, expression, value)) return;
    // A value that decides the place later may leave no result of the operation that fits: the end of the check tells.
    if (
      members(place.type).some((member) => member.kind === "open") &&
      this.#unknownOperations.has(unwrap(expression))
    )
      this.#deferred.push({
        kind: "lateStore",
        file: this.#file,
        at: this.diagnostics.length,
        place,
        expression,
        value,
      });
    if (isAssignable(place.type, value)) {
      // A place without a written type, or whose type the value would decide, cannot keep a mixed `askChoice`.
      if (place.inferred !== undefined || members(place.type).some((member) => !isKnown(member)))
        this.#reportMixedChoice(expression, (written) =>
          place.inferred === "variable" && place.declared
            ? `to keep both, ${declareAs(place.declared, written)}`
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
        this.#rewiden(place.widening.root, { path: place.widening.path, part: place.type });
      this.#follow(place.widening, value, expression.span);
      return;
    }
    if (this.#widens(place, value, expression)) return;
    const property = misfitProperty(kept, value);
    if (property !== undefined) {
      this.#report(
        typeCode.typeMismatch,
        `${place.subject}, so its property '${property.name}', which holds ${describeValue(property.kept)}, cannot be set to ${describeValue(property.value)}.${this.#copyNote(place.widening, place.type)} Use a separate property for a value of another type.`,
        expression.span,
      );
      return;
    }
    this.#report(
      typeCode.typeMismatch,
      `${place.subject}, so it cannot ${place.verb} ${describeValue(value)}.${this.#widenedNote(expression)}${this.#copyNote(place.widening, place.type)}${checkFirstFix(place.type, value, expression, place.listed) ?? place.fix(value, expression)}`,
      expression.span,
    );
  }

  /**
   * Why a place of type `type` has its type when it is, or is inside, a copy of another variable's place that was still
   * undecided (see `Copies`). A part that a value of its own decided, such as a property added to the copy later, has
   * its own reason.
   */
  #copyNote(owner: PlacePath | undefined, type: StaticType): string {
    const copies = owner === undefined ? undefined : this.#copies.get(owner.root);
    if (owner === undefined || copies === undefined || findDecidedSlot(type) !== null) return "";
    for (let length = owner.path.length; length >= 0; length -= 1) {
      const source = copies.get(owner.path.slice(0, length).join("."));
      if (source !== undefined)
        return ` '${declaredName(owner.root)}' was copied from '${source}' before its type was decided, so the first value stored in '${source}' decided it.`;
    }
    return "";
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
    const decisions = this.#decided.get(declaration);
    if (decisions !== undefined) {
      const pending = new Map<string, readonly string[]>();
      for (const path of decisions.keys()) pending.set(path, path === "" ? [] : path.split("."));
      this.#pendingDecisions.set(declaration, pending);
      // A decided part may bring elements or properties that earlier checks widened.
      if (this.#decide(declaration, own).length > 0) {
        for (const path of paths?.keys() ?? []) if (path !== "") widenPath(own, path.split("."));
        ownPartOrigins(own, (path) => this.#partOrigin(declaration, path));
      }
    }
    return own;
  }

  /**
   * Widens again what earlier checks widened inside a variable, and gives new parts their origins, for elements and
   * properties that a store added after the variable was created.
   *
   * A store names the part it changed, so only that part and what decisions change are visited: every other part got
   * its origins and widenings when it was added, and visiting the whole variable on each store would make an object that
   * grows one property at a time cost the square of its size. The whole variable is visited when no part is named, when
   * a widening that this check recorded may concern any part, or when the store's path does not lead to the part it
   * changed.
   */
  #rewiden(root: Declaration, changed?: ChangedPart): void {
    const variable = this.#declared.get(root);
    if (variable === undefined) return;
    const whole =
      changed === undefined ||
      this.#unappliedWidening.has(root) ||
      !holdsAt(variable.type, changed.path, changed.part);
    this.#unappliedWidening.delete(root);
    const decided = this.#decide(root, variable.type);
    const parts = whole ? [[]] : [changed.path, ...decided];
    const keys = new Set(parts.map((part) => part.join(".")));
    for (const path of this.#widened.get(root)?.keys() ?? [])
      if (path !== "" && withinKeys(path, keys)) widenPath(variable.type, path.split("."));
    for (const part of parts)
      ownPartOriginsAt(variable.type, (path) => this.#partOrigin(root, path), part);
  }

  /**
   * Decides in a variable's type what earlier checks found decided after a read (see {@link Decided}), for the parts
   * it has: a property that a store adds later is decided when it is added. Returns the paths it decided.
   */
  #decide(root: Declaration, type: StaticType): (readonly string[])[] {
    const pending = this.#pendingDecisions.get(root);
    if (pending === undefined || pending.size === 0) return [];
    const decisions = this.#decided.get(root)!;
    const decided: (readonly string[])[] = [];
    for (const [path, steps] of pending) {
      // Most pending paths name a property not added yet; finding that needs no walk through the type.
      if (lacksPath(type, steps)) continue;
      const { type: value, at } = decisions.get(path)!;
      if (decidePath(type, steps, value, at)) {
        pending.delete(path);
        decided.push(steps);
      }
    }
    return decided;
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
    const root =
      entry?.kind === "variable"
        ? entry.variable.declaration
        : // A speaker that receives a property that keeps a type stands for the object of its custom properties.
          entry?.kind === "speaker" && (steps.length === 0 || this.#keepsType(steps.at(-1)!))
          ? entry.custom.declaration
          : undefined;
    return root === undefined ? undefined : { root, path: steps.reverse() };
  }

  /**
   * Records that an integer variable, element, or property takes a value whose integers derive from other places (see
   * the `origins` of a scalar type), as its first value or by a later store, so it widens together with them. A
   * structured value carries each of its integers to the matching part.
   */
  #follow(target: PlacePath | undefined, value: StaticType, at: SourceSpan): void {
    if (target === undefined) return;
    // The origins are not listed here: a copy's parts keep every origin of what they were copied from, so listing them
    // for each store would grow with the square of a chain of copies.
    for (const part of integerParts(value))
      this.#followers.push({
        place: { root: target.root, path: [...target.path, ...part.path] },
        at,
        origins: part.origins,
      });
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
   * not decided until a place gives them one, and at what an operation of unknown result can give. It reports nothing
   * and changes no type.
   */
  *#fitsTask(type: StaticType, expression: Expression): CompileTask<boolean> {
    const literal = unwrap(expression);
    if (
      literal.kind !== "listLiteral" &&
      literal.kind !== "setLiteral" &&
      literal.kind !== "dictLiteral"
    ) {
      const value = this.#typeOf(expression);
      return isAssignable(type, value) && this.#unfitResults(expression, value, type) === undefined;
    }
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
            elementPlace(
              member,
              label,
              this.#declaredOf(collectionExpression, scope),
              nullable,
              this.#text,
              inferred,
              owner,
              verb,
              listed,
            ),
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
    // A part of unknown type fits a member only if a result of an operation that gives it could.
    const unknownParts = containsType(value, (part) => part.kind === "unknown");
    const passing: StaticType[] = [];
    for (const [index, member] of collections.entries())
      if (
        isAssignable(places[index]!.type, value) &&
        (!unknownParts || (yield* compileChild(this.#fitsTask(places[index]!.type, expression))))
      )
        passing.push(member);
    if (passing.length === collections.length) {
      for (const place of places) yield* compileChild(this.#storeTask(place, expression, value));
      return;
    }
    // Which member holds the collection is known only when the script runs, which checks such a value then.
    if (passing.length > 0 && unknownParts) {
      for (const [index, place] of places.entries())
        if (passing.includes(collections[index]!))
          yield* compileChild(this.#storeTask(place, expression, value));
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
   * Lets the `default:` of a list or dict `get` decide an element or value type that no value decided yet, as a first
   * stored value would (V30 §16, §40), so that `counts.get(key, default: 0) + 1` counts. A default of unknown type
   * decides nothing, and neither does a null default, so the type never starts as only null for a collection that holds
   * no null (#831). Parts of the default that the compiler cannot know are checked when the script runs. A test may
   * narrow a variable whose own type is still undecided, which the default then decides. Where a read saw the type
   * undecided before, a later check starts with the type this default decided, and the default stays its first value.
   */
  *#defaultDecidesTask(
    call: CallExpression,
    collectionExpression: Expression,
    receiver: StaticType,
    defaultExpression: Expression,
    fallback: StaticType,
    scope: Scope,
    kind: "list" | "dict",
  ): CompileTask<void> {
    const node = unwrap(collectionExpression);
    const entry = node.kind === "identifier" ? scope.resolve(node.name) : undefined;
    const own = entry?.kind === "variable" ? entry.variable.type : receiver;
    const decides = (type: StaticType): boolean => {
      const shared = elementStoreType(type);
      return (
        undecidedValues(type) ||
        (shared !== undefined && findDecidedSlot(shared) === defaultExpression.span)
      );
    };
    if (!decides(receiver) && !decides(own)) return;
    if (!isKnown(fallback) || decidedValue(fallback).kind === "never") return;
    const collection = this.#elementReceiver(collectionExpression, scope, receiver, fallback);
    yield* compileChild(
      this.#storeElementTask(
        collection,
        collectionExpression,
        defaultExpression,
        fallback,
        scope,
        "default to",
      ),
    );
    this.#recordRuntimeCheck(
      call,
      elementStoreType(collection) ?? UNKNOWN_TYPE,
      elementLabel(expressionLabel(collectionExpression), kind),
      fallback,
    );
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
    const objectLabel = expressionLabel(objectExpression);
    const label = `${objectLabel ?? "this object"}.${name}`;
    const all = members(object).map(resolved);
    const targets = all.map((member) => assignableProperty(member, name));
    let type: StaticType | undefined;
    for (const [index, target] of targets.entries()) {
      if ("problem" in target) {
        const passing = all.filter((_, other) => !("problem" in targets[other]!));
        if (passing.length > 0) this.#reportMayBe(objectExpression, all[index]!, passing);
        else
          this.#report(
            handleMemberCode(all[index]!.kind),
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
    // Only an object's property has a first value that a fix may give another type; a handle's has a fixed type.
    return propertyPlace(
      type,
      label,
      `'${label}'`,
      this.#text,
      extendPath(owner, name),
      objectLabel !== null && all.every((member) => member.kind === "object")
        ? { kind: "property", label }
        : null,
    );
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
        `to keep both, declare the result type, as in '${functionHead(context.fn.declaration)}: ${written}'`,
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
    const accepted: Variable[] = parameters.map((parameter, index) => ({
      ...parameter,
      type: copyType(parameter.type),
      shared: this.#sharedLocal(declaration.parameters[index]!),
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
   * return value of unknown type makes the result unknown, but the known values must still agree, also beside a value
   * the compiler cannot know inside a return or a place such a value reached. Every return must also fit the result, so
   * a value that fails either join is an error.
   */
  #inferredResult(context: FunctionContext): StaticType {
    const join = new TypeJoin();
    const known = new TypeJoin(true);
    // A return that holds only null decides no type, so a value of another type is compared with the first that does,
    // and where known values disagree, with the first that holds no value the compiler cannot know, if there is one.
    let first: { readonly type: StaticType; readonly span: SourceSpan } | undefined;
    let firstKnown: typeof first;
    for (const returned of context.returns) {
      if (resolved(returned.type).kind === "unknown") continue;
      const fits = join.add(returned.type);
      const agrees = known.add(returned.type);
      if (!fits || !agrees) {
        const earlier = agrees ? first! : (firstKnown ?? first!);
        this.#report(
          typeCode.mixedTypes,
          `'${context.fn.declaration.name.name}' returns ${describeValue(returned.type)} here, but ${describeValue(earlier.type)} on line ${earlier.span.start.line + 1}.${returnUnionFix(context.fn.declaration, agrees ? join.type : known.type, returned.type)}`,
          returned.span,
        );
      } else if (decidedValue(returned.type).kind !== "never") {
        first ??= returned;
        if (firstKnown === undefined && !mayBeUnknown(returned.type)) firstKnown = returned;
      }
    }
    if (context.returns.some((returned) => resolved(returned.type).kind === "unknown"))
      return UNKNOWN_TYPE;
    if (context.returns.length === 0) return NULL_TYPE;
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
    const outerScope = this.#outer;
    // A default runs in the function, so a block it creates shares the parameters before it.
    this.#outer = fn.scope;
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
                declared: { kind: "parameter", parameter },
                subject: `Parameter '${name}' is declared as ${typeName(declared)}`,
                verb: "default to",
                fix: (rejected, expression) =>
                  parameterFix(parameter, declared, rejected, expression),
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
        shared: this.#sharedLocal(parameter),
        declaration,
        annotated: parameter.typeAnnotation !== null,
        parameter,
      };
      if (declaration !== undefined) this.#declared.set(declaration, variable);
      parameters.push(variable);
      scope.declare(name, { kind: "variable", variable });
    }
    this.#reportMixedLiterals();
    this.#flow = outerFlow;
    this.#outer = outerScope;
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
        declared: { kind: "parameter", parameter: declaration },
        subject: `'${name}' takes '${parameter.name}' as ${describeValue(parameter.type)}`,
        verb: "take",
        fix: (rejected, value) => parameterFix(declaration, parameter.type, rejected, value),
      };
      yield* compileChild(this.#storeTask(place, argument.value, values[argumentIndex]!, false));
      // The argument does not change the parameter's type, but its objects reach the parameter (#845).
      flowInto(parameter.type, values[argumentIndex]!);
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
    if (result.kind === "placeRead") {
      this.#placeReads.add(expression);
      // A store that decides the place later in the check decides it for this read too (see `Decided`).
      observe(type);
    }
    this.#types.set(expression, type);
    return type;
  }

  /**
   * A range that `for` goes through, `randomInteger` draws from, `toList` gives, or a wait or timer counts in units
   * (`subject`) has whole-number bounds (V30 §6): a bound of type `number` is an error rather than a truncation. Returns
   * whether the bounds may be whole; a bound the compiler cannot know is checked at runtime.
   */
  #checkWholeRangeBounds(expression: Expression, subject: string): boolean {
    const range = unwrap(expression);
    if (range.kind !== "rangeExpression") return true;
    let whole = true;
    for (const [part, side] of [
      [range.start, "start"],
      [range.end, "end"],
    ] as const) {
      const type = this.#typeOf(part);
      if (!isScalar(type, "number")) continue;
      whole = false;
      this.#report(
        typeCode.invalidRangeOperand,
        wholeRangeMessage(
          subject,
          `its ${side} is ${describeValue(type)}`,
          this.#widenedNote(part),
        ),
        part.span,
      );
    }
    return whole;
  }

  /**
   * A range written where `randomInteger` draws a number from it, or a wait or timer a number of units (`delay`), in
   * the runtime's order: a start that gives a wait or timer no length, whole-number bounds, and at least one number to
   * draw. A bound the compiler cannot know is checked at runtime. Returns whether it reported a problem.
   */
  #checkDrawnRange(
    expression: Expression,
    subject: string,
    delay?: {
      readonly command: "wait" | "timer";
      readonly repeat: boolean;
      readonly unit: DurationUnit;
    },
  ): boolean {
    const range = unwrap(expression);
    if (range.kind !== "rangeExpression") return false;
    const start = this.#known(range.start);
    const end = this.#known(range.end);
    const known: RangeBounds | undefined =
      typeof start === "number" && typeof end === "number"
        ? { start, end, inclusive: range.inclusive }
        : undefined;
    if (delay !== undefined && typeof start === "number") {
      const problem = rangeStartProblem(
        delay.command,
        delay.repeat,
        start,
        delay.unit,
        known === undefined
          ? `this range starts at ${withoutNegativeZero(start)}`
          : `this range is ${rangeText(known)}`,
      );
      if (problem !== null) {
        this.#report(typeCode.invalidRangeOperand, problem, range.span);
        return true;
      }
    }
    if (!this.#checkWholeRangeBounds(range, subject)) return true;
    const empty = known === undefined ? null : emptyRangeProblem(subject, known);
    if (empty !== null) this.#report(typeCode.invalidRangeOperand, empty, range.span);
    return empty !== null;
  }

  /**
   * A range written in a `toList()` call whose bounds the compiler knows gives at most `MAX_COLLECTION_LENGTH` numbers
   * (V30 §6). Bounds that a number cannot hold exactly are left to the runtime, which names them.
   */
  #checkRangeListLength(expression: Expression): void {
    const range = unwrap(expression);
    if (range.kind !== "rangeExpression") return;
    const start = staticNumber(range.start);
    const end = staticNumber(range.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return;
    const length = end! - start! + (range.inclusive ? 1 : 0);
    if (!Number.isSafeInteger(length)) return;
    const problem = rangeListLengthProblem(start!, end!, range.inclusive);
    if (problem !== null) this.#report(typeCode.invalidOperand, problem, expression.span);
  }

  /**
   * Warns when a range with a whole-number literal on each side, such as `3..=1` or `5..5`, contains no numbers, naming
   * the `result`, such as "the loop never runs" (V30 §6). A computed bound stays silent, even one the compiler knows.
   */
  #warnEmptyRange(expression: Expression, result: string): void {
    const range = unwrap(expression);
    if (range.kind !== "rangeExpression") return;
    const bounds = literalRange(range);
    if (
      bounds === undefined ||
      !isScalar(this.#typeOf(range.start), "integer") ||
      !isScalar(this.#typeOf(range.end), "integer")
    )
      return;
    const { start, end, inclusive, startText, endText } = bounds;
    if (inclusive ? end >= start : end > start) return;
    const operator = inclusive ? "..=" : "..";
    const reason =
      start === end
        ? `'${startText}${operator}${endText}' excludes its end. Write '${startText}..=${endText}' for the single number ${startText}.`
        : `a range never counts down. Write '${endText}${operator}${startText}' to count up.`;
    this.diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Warning,
        typeCode.constantTest,
        `This range contains no numbers, so ${result}: ${reason}`,
        expression.span,
      ),
    );
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
        const value = durationLiteralValue(expression);
        if (typeof value === "string")
          this.#report(
            typeCode.invalidOperand,
            calendarAmountMessage(value, expression.unit, expression.amount.value),
            expression.span,
          );
        return expression.calendar ? CALENDAR_DURATION_TYPE : DURATION_TYPE;
      }
      case "stringLiteral":
        for (const part of expression.parts)
          if (part.kind === "stringInterpolation")
            yield* compileChild(this.#interpolationTask(part.expression, scope));
        return STRING_TYPE;
      case "regexLiteral":
        return REGEX_TYPE;
      case "parenthesizedExpression": {
        const type = yield* compileChild(this.#expressionTask(expression.expression, scope));
        return this.#placeReads.has(expression.expression) ? placeRead(type) : type;
      }
      case "identifier": {
        const entry = scope.resolve(expression.name);
        if (entry?.kind === "variable") return placeRead(this.#currentType(entry.variable));
        if (entry?.kind === "speaker" || (entry === undefined && expression.name === "speaker"))
          return { kind: "speaker" };
        if (expression.name === "debugMode") return BOOLEAN_TYPE;
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
        // `askChoice` that returns values of different types mixes them too.
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
        // Each key is text; the values share one type like the elements of a list (rule 1.3). Keys the compiler knows
        // must differ; keys known only at runtime replace earlier entries instead.
        const types: StaticType[] = [];
        const keys = new Set<string>();
        for (const entry of expression.entries) {
          const key = yield* compileChild(this.#expressionTask(entry.key, scope));
          this.#checkDictKey(key, entry.key);
          const text = staticChoiceValue(entry.key)?.value;
          if (typeof text === "string" && keys.has(text))
            this.#report(
              typeCode.duplicateProperty,
              duplicateEntryMessage("dict", text),
              entry.key.span,
            );
          if (typeof text === "string") keys.add(text);
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
        const properties = new PropertyTable();
        for (const property of expression.properties) {
          yield* compileChild(this.#expressionTask(property.value, scope));
          const value = this.#capture(property.value);
          // A property is a place without a declared type, so it cannot keep a mixed `askChoice` (#511 C2).
          this.#reportMixedChoice(property.value, () => ONE_TYPE_FIX);
          properties.set(property.name.name, freshPlaceType(value));
        }
        return { kind: "object", properties };
      }
      case "propertyAccessExpression": {
        if (isAccountName(expression.object)) return this.#accountFieldType(expression);
        const object = yield* compileChild(this.#expressionTask(expression.object, scope));
        const name = expression.property.name;
        this.#noteSpeakerRead(expression, object, scope);
        const custom = this.#customProperties(expression.object, object, name, scope);
        if (custom === undefined) return this.#propertyType(object, expression);
        // A custom property that no store gave the speaker yet is of unknown type.
        return memberPropertyType(custom, name) ?? placeRead(UNKNOWN_TYPE);
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
      case "unitExpression": {
        const operand = yield* compileChild(this.#expressionTask(expression.operand, scope));
        const value = nonNullTypeForUse(operand);
        const type = expression.calendar ? CALENDAR_DURATION_TYPE : DURATION_TYPE;
        // A wait or timer then refuses it as a calendar duration.
        if (
          expression.calendar &&
          resolved(value).kind === "range" &&
          this.#timeOperands.has(expression)
        )
          return type;
        // A known amount must give whole calendar days or months, like a literal.
        const amount = this.#known(expression.operand);
        const known = typeof amount === "number" ? unitValue(amount, expression) : undefined;
        if (typeof amount === "number" && typeof known === "string")
          this.#report(
            typeCode.invalidOperand,
            calendarAmountMessage(known, expression.unit, amount),
            expression.span,
          );
        const unit = expression.calendar ? `calendar ${expression.unit}` : expression.unit;
        this.#reportUnless(operand, isNumeric, expression.operand, UNIT_AMOUNT_RULE, () => {
          if (isScalar(value, "duration", "calendarDuration")) return unitAmountFix(unit, true);
          if (resolved(value).kind !== "range") return unitAmountFix(unit, false);
          // A wait refuses a calendar range, so the example takes the exact unit of the same name, if any.
          const range = expressionText(expression.operand);
          const exact =
            expression.unit === "mo" || expression.unit === "y" ? null : expression.unit;
          return range === null || exact === null
            ? " Only a wait or timer takes a range with a unit."
            : ` Only a wait or timer takes a range with a unit, as in 'wait ${range} ${exact}'.`;
        });
        return type;
      }
      case "angleExpression": {
        const operand = yield* compileChild(this.#expressionTask(expression.operand, scope));
        this.#reportUnless(operand, isNumeric, expression.operand, UNIT_AMOUNT_RULE, () =>
          unitAmountFix(expression.unit, isScalar(nonNullTypeForUse(operand), "angle")),
        );
        return ANGLE_TYPE;
      }
      case "unaryExpression": {
        if (expression.operator === "not")
          return yield* compileChild(this.#valueOfConditionTask(expression, scope));
        const operand = yield* compileChild(this.#expressionTask(expression.operand, scope));
        return this.#operation(expression.operator, [operand], expression, (value) =>
          isNumeric(value) || isScalar(value, "duration", "calendarDuration", "angle")
            ? negatedValues(resolved(value), expression.operator)
            : undefined,
        );
      }
      case "binaryExpression":
        return yield* compileChild(this.#binaryTask(expression, scope));
      case "rangeExpression": {
        // The bounds as the runtime spells them: a variable, a property path, or a number.
        const spelled = (bound: Expression): string | null => {
          const literal = unwrap(bound);
          return (
            expressionLabel(bound) ??
            (literal.kind === "numberLiteral" ? String(literal.value) : null)
          );
        };
        const labels = { start: spelled(expression.start), end: spelled(expression.end) };
        for (const place of ["start", "end"] as const) {
          const bound = expression[place];
          const type = yield* compileChild(this.#expressionTask(bound, scope));
          this.#reportUnless(
            type,
            isNumeric,
            bound,
            rangeBoundRule(labels.start, labels.end, expression.inclusive, place),
            () => {
              const text = isScalar(type, "string") ? staticVisibleText(bound) : undefined;
              const value =
                nonNullType(type).kind === "never"
                  ? "null"
                  : text !== undefined && numberFromText(text) !== undefined
                    ? "numeric text"
                    : "other";
              return ` ${notNumberFix(labels[place], value)}`;
            },
            typeCode.invalidRangeOperand,
          );
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
      case "showPopupExpression":
        yield* compileChild(this.#showPopupTask(expression, scope));
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
      case "sayExpression":
        yield* compileChild(this.#sayTask(expression, scope));
        this.#suspend();
        return { kind: "messageHandle" };
      case "showPermanentButtonExpression":
        yield* compileChild(this.#permanentButtonTask(expression, scope));
        return { kind: "permanentButton" };
      case "loadExpression": {
        yield* compileChild(this.#storageKeyTask(expression.key, scope, true));
        let fallback: StaticType = UNKNOWN_TYPE;
        if (expression.defaultValue !== null) {
          // The default runs only for a missing key.
          fallback = yield* compileChild(this.#mayRunTask(expression.defaultValue, scope));
          if (holdsSessionValue(fallback)) {
            const given = unwrap(expression.defaultValue);
            const fix = !containsType(fallback, (part) => part.kind === "messageHandle")
              ? "Give a default such as a number, a text, or a list of numbers or texts."
              : given.kind === "identifier" &&
                  resolved(nonNullType(fallback)).kind === "messageHandle"
                ? `Use the message's text instead, as in 'default: ${given.name}.text'.`
                : "Use the message's text instead.";
            this.#report(
              typeCode.invalidOperand,
              `A load's default must be a value that can be saved, because 'load' gives the default in place of a saved value. This default is ${describeValue(fallback)}. ${SESSION_VALUES} cannot be saved. ${fix}`,
              expression.defaultValue.span,
            );
            this.#rejectedDefaults.add(expression);
            return UNKNOWN_TYPE;
          }
        }
        // A key computed at runtime has no type: its load gives a value the compiler cannot know (rule 6.2).
        const key = staticText(expression.key);
        if (key === undefined) return UNKNOWN_TYPE;
        // A load reads the stored value as the declared type of the variable that receives it, or else as the type
        // another load of the key declares, or else as its default's type (rule 6.2).
        const own = this.#loadReceivers.get(expression);
        const kept = this.#storageType(key);
        if (own === undefined) this.#guessedLoads?.add(key);
        const given = nonNullType(fallback);
        const givenKind = resolved(given).kind;
        let read: StaticType;
        if (own !== undefined) {
          read = nonNullType(own);
          if (
            kept?.declared === true &&
            !sameType(kept.type, read) &&
            this.#storageAt(key, kept) !== expression.span
          )
            this.#report(
              typeCode.typeMismatch,
              `${storageLabel(key)} is declared as ${describeValue(kept.type)} on ${this.#line(kept.at)}, so it cannot be declared as ${describeValue(read)} here. Declare its type at one load only. The other loads use that type.`,
              expression.span,
            );
        } else if (kept?.declared === true) {
          read = detachedType(kept.type);
          this.#declaredLoads.add(expression);
          // A default the compiler cannot know may be anything, also null; it is checked when the load uses it.
          if (mayBeUnknown(fallback)) {
            this.storageLoads.push({ key, type: read, at: expression.span, declared: false });
            this.#runtimeChecks.push({ site: expression, place: read, label: storageLabel(key) });
            // Stored data may come from an older version of the script, with other properties (#845).
            openTables(read);
            return optional(read);
          }
          if (givenKind !== "never" && !isAssignable(read, given))
            this.#report(
              typeCode.typeMismatch,
              `${storageLabel(key)} is declared as ${describeValue(read)} on ${this.#line(this.#storageAt(key, kept))}, so its default cannot be ${describeValue(given)}.`,
              expression.defaultValue!.span,
            );
        } else {
          // Without a declared type, a default of null says nothing about the stored value.
          if (givenKind === "never") {
            this.#report(
              typeCode.typeMismatch,
              `default: null needs a declared type, as in 'let value: string? = load(${JSON.stringify(key)}, default: null)'.`,
              expression.span,
            );
            return UNKNOWN_TYPE;
          }
          // A default of a type the compiler cannot know, or that no value decided yet, gives a value it cannot know.
          if (givenKind === "unknown" || givenKind === "open") return UNKNOWN_TYPE;
          read = given;
          if (kept === undefined) this.keysReadAsDefault.add(key);
          // Each type that loads without a declared type read before this one accepts every value of it, or it of them.
          const earlier = kept?.loads ?? [];
          const text = typeKey(read);
          const first = earlier.findIndex((load) => load.text === text);
          const conflict = earlier.find(
            (load, index) =>
              (first === -1 || index < first) &&
              !isAssignable(load.type, read) &&
              !isAssignable(read, load.type),
          );
          if (conflict !== undefined) {
            const both = union([conflict.type, read]);
            this.#report(
              typeCode.typeMismatch,
              `${storageLabel(key)} is loaded as ${describeValue(conflict.type)} on ${this.#line(this.#storageAt(key, conflict))}, so it cannot be loaded as ${describeValue(read)} here.${isAnnotatable(both) ? ` To allow both, declare its type at one load, as in 'let value: ${typeName(both)} = load(...)'.` : ""}`,
              expression.span,
            );
          }
        }
        this.storageLoads.push({
          key,
          type: read,
          at: expression.span,
          declared: own !== undefined,
        });
        this.#runtimeChecks.push({ site: expression, place: read, label: storageLabel(key) });
        // A default the compiler cannot know is checked where a variable with a declared type takes it.
        if (mayBeUnknown(fallback)) return UNKNOWN_TYPE;
        if (own !== undefined) return own;
        // A part that no value decided, such as the elements of `default: []`, is checked by nothing when the script
        // runs, so it holds values the compiler cannot know, also after a later value decides the variable's part.
        const type = decidedType(detachedType(read));
        // Stored data may come from an older version of the script, with other properties (#845).
        openTables(type);
        return isNullable(fallback) ? optional(type) : type;
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

  /**
   * `askForm` (V30 §20): the question, `hint:`, and `outro:` are shown text, `submit:` is text or a button object, and
   * `fields:` is an object of fields. The result has a property per field, typed as the field's kind gives it, and the
   * shape the runtime needs is recorded for the lowering.
   */
  *#formTask(expression: InteractionExpression, scope: Scope): CompileTask<StaticType> {
    const answers = yield* compileChild(this.#formAnswersTask(expression, scope));
    const argument = (name: string) =>
      expression.formArguments.find((candidate) => candidate.name.name === name)?.value;
    const timeout = argument("timeout");
    const onTimeout = argument("onTimeout");
    if ((timeout === undefined) !== (onTimeout === undefined))
      this.#report(
        typeCode.invalidOperand,
        timeout === undefined
          ? "askForm onTimeout: needs timeout:, such as 'timeout: 30 s'."
          : 'askForm timeout: needs onTimeout: "submit" or onTimeout: "cancel".',
        expression.span,
      );
    const action = onTimeout === undefined ? undefined : staticText(onTimeout);
    if (action !== undefined && action !== "submit" && action !== "cancel")
      this.#report(
        typeCode.invalidOperand,
        `askForm onTimeout: takes "submit" or "cancel", not ${JSON.stringify(action)}.`,
        onTimeout!.span,
      );
    if (action === "submit") this.#checkFormStarts(expression);
    // With `cancel:`, or a time limit that may cancel, the whole form may return `null`.
    const cancellable =
      argument("cancel") !== undefined || (onTimeout !== undefined && action !== "submit");
    return cancellable && isKnown(answers) ? optional(answers) : answers;
  }

  /**
   * `onTimeout: "submit"` returns the answers as they stand, so every field needs a value from the start. Fields written
   * where the form is asked are checked here; others are checked when the form opens.
   */
  #checkFormStarts(expression: InteractionExpression): void {
    const fields = expression.formArguments.find((argument) => argument.name.name === "fields");
    const literal = fields === undefined ? undefined : unwrap(fields.value);
    const written =
      literal?.kind === "objectLiteral"
        ? literal.properties.map((property) => ({
            name: property.name.name,
            value: property.value,
          }))
        : literal?.kind === "dictLiteral"
          ? literal.entries.map((entry) => ({
              name: staticText(entry.key) ?? "?",
              value: entry.value,
            }))
          : [];
    for (const property of written) {
      const descriptor = unwrap(property.value);
      if (descriptor.kind === "nullLiteral" || descriptor.kind === "objectLiteral") {
        const start =
          descriptor.kind === "objectLiteral"
            ? descriptor.properties.find((candidate) => candidate.name.name === "value")?.value
            : descriptor;
        const finite =
          descriptor.kind === "objectLiteral" &&
          descriptor.properties.some((candidate) => candidate.name.name === "options");
        const tag =
          descriptor.kind === "objectLiteral"
            ? descriptor.properties.find((candidate) => candidate.name.name === "type")
            : undefined;
        const toggle = tag !== undefined && staticText(tag.value) === "boolean";
        if (!finite && !toggle && (start === undefined || unwrap(start).kind === "nullLiteral"))
          this.#report(
            typeCode.invalidOperand,
            `askForm field '${property.name}': onTimeout: "submit" needs a value in every field. Give it 'value:'.`,
            property.value.span,
          );
      }
    }
  }

  *#formAnswersTask(expression: InteractionExpression, scope: Scope): CompileTask<StaticType> {
    if (expression.question !== null) {
      const type = yield* compileChild(this.#expressionTask(expression.question, scope));
      this.#checkShownText(expression.question, type, "an ask question");
    }
    let fields: { readonly expression: Expression; readonly type: StaticType } | null = null;
    for (const { name, value } of expression.formArguments) {
      const type = yield* compileChild(this.#expressionTask(value, scope));
      if (name.name === "fields") fields = { expression: value, type };
      else if (name.name === "submit" || name.name === "cancel") {
        if (unwrap(value).kind !== "objectLiteral")
          this.#reportUnless(
            type,
            (member) => isShowable(member) || resolved(member).kind === "object",
            value,
            `'${name.name}:' takes text or a button object { text, background? }`,
          );
      } else if (name.name === "timeout") {
        this.#reportNonDuration(value, type, "An askForm timeout is a duration", "30 s", () =>
          unitFix(value),
        );
        this.#checkTimeoutLength("askForm", value);
      } else if (name.name === "onTimeout")
        this.#reportUnless(
          type,
          (member) => isScalar(member, "string"),
          value,
          `'onTimeout:' takes "submit" or "cancel"`,
        );
      else
        this.#checkShownText(value, type, name.name === "hint" ? "an input hint" : "a form outro");
    }
    if (fields === null) return UNKNOWN_TYPE;
    const container = resolved(nonNullType(fields.type));
    if (container.kind === "dict") {
      // A written dict shows every field, so its answers are typed field by field.
      const literal = unwrap(fields.expression);
      if (literal.kind === "dictLiteral" && literal.entries.length > 0) {
        const entries = literal.entries.map((entry) => ({
          entry,
          field: this.#formField(
            staticText(entry.key) ?? "?",
            this.#typeOf(entry.value),
            entry.value,
          ),
        }));
        // The form has one number kind for the dict's fields without `type:`.
        const starts = entries.filter(({ field }) => field.start !== null);
        const kinds = new Set(
          starts.map(({ field }) =>
            isScalar(resolved(nonNullType(field.start!)), "integer") ? "integer" : "number",
          ),
        );
        if (kinds.size > 1)
          for (const { entry } of starts)
            this.#report(
              typeCode.invalidOperand,
              `askForm field '${staticText(entry.key) ?? "?"}': its dict mixes whole and decimal numbers. Add type: "integer" or type: "number".`,
              entry.value.span,
            );
        const element = union(entries.map(({ field }) => field.result));
        this.#forms.set(expression, {
          kind: "dict",
          start: kinds.size === 1 ? starts[0]!.field.start : null,
          answer: element,
        });
        return { kind: "dict", element };
      }
      // Otherwise every field has the type of the dict's values.
      const field = this.#formField("?", container.element, undefined);
      this.#forms.set(expression, { kind: "dict", start: field.start, answer: field.result });
      return { kind: "dict", element: field.result };
    }
    if (container.kind !== "object") {
      if (isKnown(container))
        this.#report(
          typeCode.invalidOperand,
          `'fields:' takes an object or dict of fields, such as 'fields: { enabled: false }', not ${describeValue(container)}.`,
          fields.expression.span,
        );
      // Fields the compiler cannot know, such as an untyped parameter's, may be an object or a dict: the form takes the
      // shape of the value when it opens.
      this.#forms.set(expression, { kind: "unknown" });
      return UNKNOWN_TYPE;
    }
    const literal = unwrap(fields.expression);
    const written = new Map(
      literal.kind === "objectLiteral"
        ? literal.properties.map((property) => [property.name.name, property.value] as const)
        : [],
    );
    const result = new PropertyTable();
    const recorded: {
      readonly name: string;
      readonly start: StaticType | null;
      readonly answer: StaticType;
    }[] = [];
    for (const [name, type] of container.properties ?? []) {
      const field = this.#formField(name, type, written.get(name));
      result.set(name, field.result);
      recorded.push({ name, start: field.start, answer: field.result });
    }
    this.#forms.set(expression, { kind: "object", fields: recorded });
    if (container.properties === null) return UNKNOWN_TYPE;
    const answers: StaticType = { kind: "object", properties: result };
    // The answers have the fields the container has when the form opens.
    flowInto(answers, container);
    return answers;
  }

  /**
   * The answer type of one field of `askForm`, and the type of the number that decides its kind when it has no
   * `type:`: its start, or its descriptor's `value:`, `min:`, or `max:`. Only what is written where the form is asked
   * proves a descriptor's properties: a computed descriptor's type merges the properties of all its values, so one
   * that may say `type:` or mix kinds answers in the generic union.
   */
  #formField(
    name: string,
    type: StaticType,
    written: Expression | undefined,
  ): { readonly result: StaticType; readonly start: StaticType | null } {
    const value = resolved(nonNullType(type));
    const literal = written === undefined ? null : unwrap(written);
    if (value.kind === "object")
      return literal?.kind === "objectLiteral"
        ? this.#writtenFormField(name, literal)
        : this.#computedFormField(value);
    const kind = formKindOfStart(value);
    if (kind === null) return { result: optional(GENERIC_FORM_ANSWER_TYPE), start: null };
    return {
      result:
        kind === "cycle"
          ? this.#cycleAnswerType(value, literal ?? undefined)
          : kind === "boolean"
            ? BOOLEAN_TYPE
            : formAnswerType(kind),
      start: kind === "integer" || kind === "number" ? value : null,
    };
  }

  /** A descriptor written where the form is asked: its properties are exactly the written ones. */
  #writtenFormField(
    name: string,
    descriptor: ObjectLiteral,
  ): { readonly result: StaticType; readonly start: StaticType | null } {
    const written = new Map(
      descriptor.properties.map((property) => [property.name.name, property.value] as const),
    );
    for (const property of descriptor.properties)
      if (!FORM_FIELD_PROPERTIES.includes(property.name.name))
        this.#report(
          typeCode.invalidOperand,
          `askForm field '${name}': unknown property '${property.name.name}'. ${FORM_FIELD_PROPERTIES_TEXT}`,
          property.name.span,
        );
    const typeOf = (property: string) => {
      const expression = written.get(property);
      return expression === undefined ? undefined : resolved(nonNullType(this.#typeOf(expression)));
    };
    let tag: FormFieldKind | null | undefined;
    const typeExpression = written.get("type");
    if (typeExpression !== undefined) {
      const text = staticText(typeExpression);
      tag = text !== undefined && isFormFieldKind(text) ? text : null;
      if (text !== undefined && !isFormFieldKind(text))
        this.#report(
          typeCode.invalidOperand,
          `askForm field '${name}': ${unknownFormTypeMessage(text)}`,
          typeExpression.span,
        );
    }
    const valueType = typeOf("value");
    const kind =
      tag !== undefined
        ? tag
        : written.has("options")
          ? valueType !== undefined && isScalar(valueType, "boolean")
            ? "boolean"
            : "cycle"
          : valueType === undefined
            ? null
            : formKindOfStart(valueType);
    // A written `optional: false` keeps the answer required; any other value may make it optional.
    const optionalExpression = written.get("optional");
    const optionalLiteral =
      optionalExpression === undefined ? undefined : unwrap(optionalExpression);
    const required =
      optionalLiteral === undefined ||
      (optionalLiteral.kind === "booleanLiteral" && !optionalLiteral.value);
    // Only an integer turns into a number; a number does not start an integer field.
    if (tag === "integer" && valueType !== undefined && isScalar(valueType, "number"))
      this.#report(
        typeCode.invalidOperand,
        `askForm field '${name}': an integer field starts with a whole number (integer), not ${describeValue(valueType)}.`,
        written.get("value")!.span,
      );
    // With a written type, the runtime needs no number kind.
    const start =
      tag !== undefined
        ? null
        : ([valueType, typeOf("min"), typeOf("max")].find(
            (part) => part !== undefined && isNumeric(part),
          ) ?? null);
    if (kind === null) return { result: optional(GENERIC_FORM_ANSWER_TYPE), start };
    const result =
      kind === "cycle"
        ? this.#cycleAnswerType(typeOf("options"), written.get("options"))
        : kind === "boolean"
          ? BOOLEAN_TYPE
          : formAnswerType(kind);
    return {
      result: !required && kind !== "boolean" && kind !== "cycle" ? optional(result) : result,
      // Only a number typed in the composer needs the form's number kind.
      start: kind === "integer" || kind === "number" ? start : null,
    };
  }

  /**
   * A computed descriptor: its type merges every value it may hold, so a property in it may be missing from some of
   * them, and a value may also hold properties its type does not show. It gives one kind only without `type:`, and with
   * `options:` only when no `value:` other than a toggle's beside it can make some fields typed. The form checks when
   * it opens that each field answers within the type given here.
   */
  #computedFormField(descriptor: Extract<StaticType, { kind: "object" }>): {
    readonly result: StaticType;
    readonly start: StaticType | null;
  } {
    const properties = descriptor.properties;
    if (properties === null) return { result: optional(GENERIC_FORM_ANSWER_TYPE), start: null };
    const part = (key: string) => {
      const found = properties.get(key);
      return found === undefined ? undefined : resolved(nonNullType(found));
    };
    const valueType = part("value");
    const start =
      [valueType, part("min"), part("max")].find((type) => type !== undefined && isNumeric(type)) ??
      null;
    const options = part("options");
    let result: StaticType | null;
    if (properties.has("type")) result = null;
    else if (options !== undefined) {
      const cycle = this.#cycleAnswerType(options, undefined);
      // Toggles with options and cycles of booleans answer booleans alike; another `value:` may be any field's.
      result =
        valueType === undefined
          ? cycle
          : isScalar(valueType, "boolean") && isScalar(resolved(cycle), "boolean")
            ? BOOLEAN_TYPE
            : null;
    } else {
      const kind = valueType === undefined ? null : formKindOfStart(valueType);
      result =
        kind === null
          ? null
          : kind === "boolean"
            ? BOOLEAN_TYPE
            : kind === "cycle"
              ? null
              : properties.has("optional")
                ? optional(formAnswerType(kind))
                : formAnswerType(kind);
    }
    // A toggle or a cycle does not take a number in the composer, so it needs no number kind.
    const finite =
      options !== undefined || (valueType !== undefined && isScalar(valueType, "boolean"));
    return {
      result: result ?? optional(GENERIC_FORM_ANSWER_TYPE),
      start: result !== null && finite ? null : start,
    };
  }

  /**
   * What a cycle returns: each option's value, or the text of a choice object without one, as an `askChoice` button
   * returns it. Written choice objects are read one by one; for a computed one, whether it has a `value` is not
   * known, so either may be returned.
   */
  #cycleAnswerType(type: StaticType | undefined, written: Expression | undefined): StaticType {
    const computedOption = (member: StaticType): StaticType => {
      const option = resolved(member);
      if (option.kind !== "object") return plainType(option);
      const returned = [option.properties?.get("value"), option.properties?.get("text")].filter(
        (part): part is StaticType => part !== undefined,
      );
      return returned.length === 0 ? UNKNOWN_TYPE : union(returned.map(plainType));
    };
    const list = written === undefined ? undefined : unwrap(written);
    if (list?.kind === "listLiteral")
      return union(
        list.elements.map((element) => {
          const option = unwrap(element);
          if (option.kind !== "objectLiteral")
            return union(members(this.#typeOf(element)).map(computedOption));
          const returned =
            option.properties.find((property) => property.name.name === "value") ??
            option.properties.find((property) => property.name.name === "text");
          return returned === undefined ? UNKNOWN_TYPE : plainType(this.#typeOf(returned.value));
        }),
      );
    const options = type === undefined ? undefined : resolved(nonNullType(type));
    if (options?.kind !== "list") return UNKNOWN_TYPE;
    return union(members(resolved(options.element)).map(computedOption));
  }

  /**
   * `askBooleans` (V30 §20): the message is shown text, `texts:` a list of texts, `prefill:` a list of booleans of the
   * same length when both are written, and `cancel:` a button. A form of toggles, it returns one boolean per text, or
   * `null` when it may be cancelled and the player cancels it.
   */
  *#askBooleansTask(expression: InteractionExpression, scope: Scope): CompileTask<StaticType> {
    let cancellable = false;
    const written = new Map<string, Expression>();
    for (const argument of namedAskArguments(expression)) {
      const type = yield* compileChild(this.#expressionTask(argument.value, scope));
      const name = argument.name;
      written.set(name, argument.value);
      if (name === "message") this.#checkShownText(argument.value, type, "an ask question");
      else if (name === "texts")
        this.#reportUnless(
          type,
          (member) =>
            member.kind === "list" && (!isKnown(member.element) || isShowable(member.element)),
          argument.value,
          "'texts:' takes a list of texts",
        );
      else if (name === "prefill")
        this.#reportUnless(
          type,
          (member) =>
            member.kind === "list" &&
            (!isKnown(member.element) || isScalar(member.element, "boolean")),
          argument.value,
          "'prefill:' takes a list of true or false",
        );
      else if (name === "cancel") {
        cancellable = true;
        if (unwrap(argument.value).kind !== "objectLiteral")
          this.#reportUnless(
            type,
            (member) => isShowable(member) || resolved(member).kind === "object",
            argument.value,
            "'cancel:' takes text or a button object { text, background? }",
          );
      }
    }
    const texts = written.get("texts");
    const prefill = written.get("prefill");
    const textsList = texts === undefined ? undefined : unwrap(texts);
    const prefillList = prefill === undefined ? undefined : unwrap(prefill);
    if (textsList?.kind === "listLiteral" && textsList.elements.length === 0)
      this.#report(typeCode.invalidOperand, "askBooleans needs at least one text.", textsList.span);
    else if (
      textsList?.kind === "listLiteral" &&
      prefillList?.kind === "listLiteral" &&
      textsList.elements.length !== prefillList.elements.length
    )
      this.#report(
        typeCode.invalidOperand,
        `askBooleans has ${textsList.elements.length} ${textsList.elements.length === 1 ? "text" : "texts"} but ${prefillList.elements.length} prefill ${prefillList.elements.length === 1 ? "value" : "values"}. Give one prefill value for each text.`,
        prefillList.span,
      );
    const answers: StaticType = { kind: "list", element: BOOLEAN_TYPE };
    return cancellable ? optional(answers) : answers;
  }

  /**
   * The message (question) and hint of `askImage` are shown text, the sources and `allowSkip:` are booleans, and `types:`
   * and `mime:` are lists of texts. Written values must be valid, and written sources must leave the player a way to
   * answer. The answer is an image reference, or also `null` unless `allowSkip:` is left out or written `false`.
   */
  *#askImageTask(expression: CallExpression, scope: Scope): CompileTask<StaticType> {
    if (expression.presentation !== undefined) {
      yield* compileChild(this.#expressionTask(expression.presentation, scope));
      this.#checkPresentation(expression.presentation);
    }
    const sources: boolean[] = [];
    let skippable = false;
    for (const argument of expression.arguments) {
      const type = yield* compileChild(this.#expressionTask(argument.value, scope));
      const name = argument.kind === "namedArgument" ? argument.name.name : "message";
      if (name === "message") this.#checkShownText(argument.value, type, "an ask question");
      else if (name === "hint") this.#checkShownText(argument.value, type, "an input hint");
      else if (name === "allowCamera" || name === "allowFile" || name === "allowSkip") {
        this.#reportUnless(
          type,
          (member) => isScalar(member, "boolean"),
          argument.value,
          `'${name}:' takes true or false`,
        );
        const written = unwrapGrouping(argument.value);
        if (name === "allowSkip") skippable = written.kind !== "booleanLiteral" || written.value;
        else if (written.kind === "booleanLiteral") sources.push(written.value);
      } else if (name === "types" || name === "mime") {
        this.#reportUnless(
          type,
          (member) =>
            member.kind === "list" &&
            (!isKnown(member.element) || isScalar(member.element, "string")),
          argument.value,
          name === "types"
            ? `'types:' takes a list of file extensions, such as [".png"]`
            : `'mime:' takes a list of image MIME types, such as ["image/png"]`,
        );
        this.#checkLiteralImageFilter(name, argument.value);
      }
    }
    // Only both sources written as false leave no way to answer; an omitted source is allowed.
    if (sources.length === 2 && !sources[0] && !sources[1])
      this.#report(typeCode.invalidOperand, IMAGE_NO_SOURCE_MESSAGE, expression.span);
    return skippable ? optional(STRING_TYPE) : STRING_TYPE;
  }

  /** The message and `buttonText:` of `showPopup` are shown text. */
  *#showPopupTask(parts: ShowPopupParts, scope: Scope): CompileTask<void> {
    for (const argument of parts.arguments) {
      const type = yield* compileChild(this.#expressionTask(argument.value, scope));
      const name = argument.kind === "namedArgument" ? argument.name.name : "message";
      if (name === "message") this.#checkShownText(argument.value, type, "a popup message");
      else if (name === "buttonText")
        this.#checkShownText(argument.value, type, "the text of a popup's button");
    }
  }

  /**
   * `openUrl` takes a web address as text. A list is never one (V30 §16), and a written address must be an `http` or
   * `https` URL; other values are checked when the statement runs. `buttonText:` is shown text and `alwaysButton:` is
   * true or false.
   */
  *#openUrlTask(statement: OpenUrlStatement, scope: Scope): CompileTask<void> {
    for (const argument of statement.arguments) {
      const type = yield* compileChild(this.#expressionTask(argument.value, scope));
      if (argument.kind === "namedArgument") {
        if (argument.name.name === "buttonText")
          this.#checkShownText(argument.value, type, "the text of an openUrl button");
        else if (argument.name.name === "alwaysButton")
          this.#reportUnless(
            type,
            (member) => isScalar(member, "boolean"),
            argument.value,
            "'alwaysButton:' takes true or false",
          );
        continue;
      }
      const label = expressionLabel(argument.value) ?? "list";
      this.#reportUnless(
        type,
        (member) => isScalar(member, "string"),
        argument.value,
        "openUrl needs a web address in text (string)",
        () =>
          members(type).some((member) => resolved(member).kind === "list")
            ? ` A list is never an address. Select one, such as '${label}[0]' or '${label}.random'.`
            : "",
      );
      const text = staticText(argument.value);
      if (text !== undefined && canonicalWebUrl(text) === null)
        this.#report(
          typeCode.invalidOperand,
          `${OPEN_URL_RULE}. ${OPEN_URL_FIX}`,
          argument.value.span,
        );
    }
  }

  /** `exportText` takes its text and `fileName:` as text (string); `title:` is shown text. */
  *#exportTextTask(statement: ExportTextStatement, scope: Scope): CompileTask<void> {
    for (const argument of statement.arguments) {
      const type = yield* compileChild(this.#expressionTask(argument.value, scope));
      const name = argument.kind === "namedArgument" ? argument.name.name : "text";
      if (name === "title") this.#checkShownText(argument.value, type, "the title of exportText");
      else if (name === "text" || name === "fileName")
        this.#reportUnless(
          type,
          (member) => isScalar(member, "string"),
          argument.value,
          name === "text"
            ? "exportText needs its text as text (string)"
            : "'fileName:' takes text (string)",
        );
    }
  }

  /** A written `types:` or `mime:` list holds at least one entry, and each written text is valid. */
  #checkLiteralImageFilter(option: "types" | "mime", written: Expression): void {
    const list = unwrapGrouping(written);
    if (list.kind !== "listLiteral") return;
    if (list.elements.length === 0) {
      this.#report(typeCode.invalidOperand, emptyImageFilterMessage(option), list.span);
      return;
    }
    for (const element of list.elements) {
      if (
        element.kind !== "stringLiteral" ||
        element.parts.some((part) => part.kind !== "stringText")
      )
        continue;
      const text = element.parts
        .map((part) => (part.kind === "stringText" ? part.value : ""))
        .join("");
      const problem = imageFilterTextProblem(option, text);
      if (problem !== null) this.#report(typeCode.invalidOperand, problem, element.span);
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
          typeCode.conflictingTag,
          conflictingTagMessage(seen.get(tag.name)!, tag),
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
        ? "No file in the project that runs something has these tags. A file of declarations only is never picked."
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
        return negatedBranches(operand);
      }
      case "binaryExpression": {
        if (node.operator === "and" || node.operator === "or") {
          const rule = logicalOperandRule(node.operator);
          const left = yield* compileChild(this.#branchTask(node.left, scope));
          this.#requireBoolean(left.type, node.left, rule);
          // The right operand runs only when the left one did not decide the result. When no value lets it run, it is
          // still checked like an `if` branch that is never taken, without what the left operand rules out.
          const runsRight = node.operator === "and" ? left.whenTrue : left.whenFalse;
          this.#noteOperand(node, [
            runsRight !== null,
            (node.operator === "and" ? left.whenFalse : left.whenTrue) !== null,
          ]);
          this.#flow.apply(
            runsRight ??
              (node.operator === "and" ? left.unreachedTrue : left.unreachedFalse) ??
              null,
          );
          const right = yield* compileChild(this.#branchTask(node.right, scope));
          this.#requireBoolean(right.type, node.right, rule);
          const reached = runsRight !== null;
          const rightTrue =
            reached && right.whenTrue !== null ? this.#flow.since(start, right.whenTrue) : null;
          const rightFalse =
            reached && right.whenFalse !== null ? this.#flow.since(start, right.whenFalse) : null;
          // The outcome that only the right operand gives is not reached when either operand rules it out.
          const unreached = (
            leftOutcome: Changes | undefined,
            rightOutcome: Changes | undefined,
          ): Changes | undefined =>
            !reached
              ? leftOutcome
              : rightOutcome === undefined
                ? undefined
                : this.#flow.since(start, rightOutcome);
          const unreachedTrue = unreached(left.unreachedTrue, right.unreachedTrue);
          const unreachedFalse = unreached(left.unreachedFalse, right.unreachedFalse);
          this.#flow.undo(start);
          return node.operator === "and"
            ? {
                type: BOOLEAN_TYPE,
                whenTrue: rightTrue,
                whenFalse: this.#flow.join([left.whenFalse, rightFalse]),
                ...(rightTrue === null && unreachedTrue !== undefined ? { unreachedTrue } : {}),
              }
            : {
                type: BOOLEAN_TYPE,
                whenTrue: this.#flow.join([left.whenTrue, rightTrue]),
                whenFalse: rightFalse,
                ...(rightFalse === null && unreachedFalse !== undefined ? { unreachedFalse } : {}),
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
        return node.operator === "==" ? tested : negatedBranches(tested);
      }
      case "typeTestExpression": {
        const value = yield* compileChild(this.#expressionTask(node.value, scope));
        const test = this.#annotationType(node.type);
        this.#warnConstantTest(node, value, test);
        const tested = this.#narrowTest(node.value, scope, test, start);
        return node.negated ? negatedBranches(tested) : tested;
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
    const passes = this.#flow.since(start, new Map([[entry.variable, passed]]));
    const fails = this.#flow.since(start, new Map([[entry.variable, failed]]));
    return {
      type: BOOLEAN_TYPE,
      whenTrue: passed.kind === "never" ? null : passes,
      whenFalse: failed.kind === "never" ? null : fails,
      ...(passed.kind === "never" ? { unreachedTrue: passes } : {}),
      ...(failed.kind === "never" ? { unreachedFalse: fails } : {}),
    };
  }

  /**
   * Warns about `==` or `!=` with a value that one side can never hold (ADR 0021 rule 4.5): an `askChoice` result
   * compared with a value no button returns (#511 C5), or values of types that are never equal, such as text and a
   * number, or a value that is never `null` compared with `null`. {@link #neverMatchingCaseValue} applies it to a
   * literal `case`.
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
   * cases above took every value of its type, as `case is integer` before `case 5`, or an `askChoice` result never is
   * it (#511 C5). The case compares with `==` (V30 §32).
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
      const within = ({ value, measure }: PossibleValue) =>
        typeof value === "number" &&
        measure === null &&
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

  /**
   * `a otherwise b otherwise c`, checked from the left (V30 §18). The result is not null unless the last fallback may
   * be, and its type joins the value and the fallback as for a list `get` default. The first `otherwise` whose left side
   * the compiler knows is never null gets warning TSV062, which names that fallback and those after it.
   */
  *#otherwiseTask(
    root: Extract<Expression, { kind: "binaryExpression" }>,
    scope: Scope,
  ): CompileTask<StaticType> {
    // The chain from the inside out; a part in parentheses is a value of its own, as in `(a otherwise b) otherwise c`.
    const chain: Extract<Expression, { kind: "binaryExpression" }>[] = [];
    let value: Expression = root;
    while (value.kind === "binaryExpression" && value.operator === "otherwise") {
      chain.push(value);
      value = value.left;
    }
    chain.reverse();
    yield* compileChild(this.#expressionTask(value, scope));
    let unused: number | null = null;
    let type: StaticType = UNKNOWN_TYPE;
    for (const [index, node] of chain.entries()) {
      // The result may be the value or the fallback itself, so it is a copy that later stores to either cannot share.
      const left = this.#capture(node.left);
      if (unused === null && neverNull(left)) unused = index;
      this.#noteOperand(node, [unused === null, true]);
      // A fallback runs only when every value before it is null, so what it changes may or may not have happened
      // afterwards, and after a value that is never null, it never runs, but is still checked.
      const start = this.#flow.mark();
      yield* compileChild(this.#expressionTask(node.right, scope));
      const changes = this.#flow.undo(start);
      if (unused === null) this.#flow.apply(this.#flow.join([new Map(), changes]));
      const replaced: OpenType[] = [];
      type = fallbackType(
        left,
        plainType(this.#capture(node.right)),
        this.#kept.has(node),
        replaced,
      );
      if (replaced.length > 0) this.#replaced.push({ node, slots: replaced });
      // The root's own type is recorded by its caller.
      if (node !== root) this.#types.set(node, type);
    }
    if (unused !== null) this.#warnUnusedFallback(chain, unused);
    return type;
  }

  /**
   * Warns that the fallbacks from `chain[first]` on are never used, because the value before that `otherwise` is never
   * null (owner decision on #850). An element read by index fails instead of giving null, so for one, the warning names
   * `get` with a `default:`.
   */
  #warnUnusedFallback(
    chain: readonly Extract<Expression, { kind: "binaryExpression" }>[],
    first: number,
  ): void {
    const node = chain[first]!;
    const unused = chain.slice(first);
    const subject = expressionText(node.left);
    const holder = subject === null ? "This value" : `'${subject}'`;
    const fallbacks = unused.map((part) => fallbackText(part.right));
    const removed = fallbacks.every((text) => text !== null)
      ? `'${fallbacks.map((text) => `otherwise ${text}`).join(" ")}'`
      : null;
    let fix =
      unused.length === 1
        ? `Remove ${removed ?? "'otherwise' and the fallback after it"}.`
        : `Remove ${removed ?? "each 'otherwise' with its fallback"}.`;
    const read = unwrap(node.left);
    if (read.kind === "indexExpression" && first === 0) {
      const collection = resolved(this.#typeOf(read.object));
      const kind = isList(collection) ? "list" : isDict(collection) ? "dict" : null;
      const parts = [expressionText(read.object), expressionText(read.index), fallbacks[0]];
      if (kind !== null)
        fix = `Reading ${kind === "list" ? "a position the list" : "a key the dict"} does not have is an error, not null. ${
          parts.every((part) => part !== null)
            ? `For a fallback there, write '${parts[0]}.get(${parts[1]}, default: ${parts[2]})'.`
            : "For a fallback there, use get with 'default:' instead."
        }`;
    }
    this.diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Warning,
        typeCode.unusedFallback,
        `${holder} is never null here, so ${unused.length === 1 ? "the fallback after 'otherwise' is" : "the fallbacks after 'otherwise' are"} never used. ${fix}`,
        createSourceSpan(node.operatorSpan.start, chain.at(-1)!.span.end),
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
    if (expression.operator === "otherwise")
      return yield* compileChild(this.#otherwiseTask(expression, scope));
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
          (isScalar(a, "calendarDuration") && isScalar(b, "calendarDuration")) ||
          (isScalar(a, "angle") && isScalar(b, "angle")) ||
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
          // The fix declares the first operand that a declaration names.
          const declared =
            [expression.left, expression.right]
              .map((operand) => this.#declaredOf(operand, scope))
              .find((found) => found !== null && found.kind !== "property") ?? null;
          this.#reportMixedJoin(
            "'+'",
            "list",
            first.element,
            second.element,
            declared,
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
   * Reports duration arithmetic that is known to fail (ADR 0026): comparing or dividing calendar durations of different
   * families, moving a date by a part of a day or a local value by a calendar duration with exact time, and calendar
   * parts that would not stay whole. Only the operands a check needs are folded, through `#known`, so any shape of chain
   * stays linear.
   */
  #checkKnownDurations(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
    left: StaticType,
    right: StaticType,
  ): void {
    const leftDuration = isScalar(left, "duration", "calendarDuration");
    const rightDuration = isScalar(right, "duration", "calendarDuration");
    if (!leftDuration && !rightDuration) return;
    const operator = expression.operator;
    const duration = (operand: Expression): AnyDuration | undefined => {
      const value = this.#known(operand);
      return isStaticDuration(value) ? value : undefined;
    };
    const number = (operand: Expression): number | undefined => {
      const value = this.#known(operand);
      return typeof value === "number" ? value : undefined;
    };
    let problem: string | number | AnyDuration | undefined;
    if (operator === "+" || operator === "-") {
      if (rightDuration) this.#checkLocalCalendarOffset(left, expression.right, expression.span);
    } else if (leftDuration && rightDuration) {
      // A calendar duration beside an exact one is a type error of its own.
      if (isScalar(left, "calendarDuration") !== isScalar(right, "calendarDuration")) return;
      const a = duration(expression.left);
      const b = a === undefined ? undefined : duration(expression.right);
      if (a !== undefined && b !== undefined)
        problem =
          operator === "/"
            ? durationQuotient(a, b)
            : ["<", "<=", ">", ">="].includes(operator)
              ? compareDurations(a, b)
              : undefined;
    } else if (operator === "*" || operator === "/") {
      // A duration times or divided by a number, or a number times a duration: calendar parts must stay whole.
      const [value, factor] = leftDuration
        ? [duration(expression.left), number(expression.right)]
        : operator === "*"
          ? [duration(expression.right), number(expression.left)]
          : [undefined, undefined];
      if (value !== undefined && factor !== undefined)
        problem = operator === "*" ? scaleDuration(value, factor) : divideDuration(value, factor);
    }
    // A zero divisor the compiler can see is a visible overflow (TSV050), reported once for the step.
    if (typeof problem === "string" && problem !== ZERO_DIVISOR)
      this.#report(typeCode.invalidOperand, `'${operator}': ${problem}.`, expression.span);
  }

  /**
   * Reports a known calendar duration with exact time that moves a local date or date and time (ADR 0026 §5), as in
   * `day + (1 calendar day + 1 h)` or `day += 1 calendar day + 1 h`.
   */
  #checkLocalCalendarOffset(target: StaticType, operand: Expression, span: SourceSpan): void {
    if (!isScalar(target, "date", "datetime")) return;
    const value = this.#known(operand);
    if (!isStaticDuration(value) || !isCalendar(value) || value.milliseconds === 0) return;
    this.#report(
      typeCode.invalidOperand,
      isScalar(target, "date")
        ? `A date moves only by calendar units, not by ${formatDuration(value)}. A date has no clock time, so leave out the ${formatDuration(value.milliseconds)}.`
        : `A date and time moves only by calendar units, not by ${formatDuration(value)}. Convert it with toAbsoluteDateTime() for elapsed time.`,
      span,
    );
  }

  /**
   * The number, duration, or angle `expression` is known to have at compile time, folded once per expression from its
   * operands' known values. Iterative, so a long chain of steps does not deepen the native stack.
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
    const reported = this.diagnostics.length;
    const type = this.#checkedOperation(operator, operands, expression, result);
    // An operand that so far held only null, such as `v` after `let v = null` once a loop or a block may have stored
    // in it, is checked as null too, in case no store gives it another value.
    const slots = operands.flatMap((operand) => nullOnlySlot(operand) ?? []);
    if (slots.length > 0 && this.diagnostics.length === reported) {
      const possible = this.#unknownOperations.get(expression);
      this.#deferNullOnly(slots, () => {
        this.#checkedOperation(
          operator,
          operands.map((operand) => (nullOnlySlot(operand) === undefined ? operand : NULL_TYPE)),
          expression,
          result,
        );
      });
      if (possible === undefined) this.#unknownOperations.delete(expression);
      else this.#unknownOperations.set(expression, possible);
    }
    return type;
  }

  #checkedOperation(
    operator: string,
    operands: readonly StaticType[],
    expression: Extract<Expression, { kind: "unaryExpression" | "binaryExpression" }>,
    result: (...values: StaticType[]) => StaticType | undefined,
  ): StaticType {
    const reported = this.diagnostics.length;
    const outcome = this.#memberOperation(
      operands,
      expression.kind === "binaryExpression"
        ? [expression.left, expression.right]
        : [expression.operand],
      result,
      operator,
    );
    let failed: readonly StaticType[];
    if ("type" in outcome) {
      if (
        isKnown(outcome.type) ||
        this.diagnostics.length !== reported ||
        ["<", "<=", ">", ">="].includes(operator)
      )
        return outcome.type;
      const possible = this.#possibleResults(operands, expression, result);
      // Left unrecorded, an operation whose operand already failed passes that on without a message of its own, to the
      // operations, stores, and compound assignments around it.
      if (possible.failed) return outcome.type;
      if (possible.results.length > 0) this.#unknownOperations.set(expression, possible.results);
      // What an inner operation can give works with nothing the other operand may be, so this always fails.
      if (possible.results.length > 0 || possible.narrowed === null) return outcome.type;
      failed = possible.narrowed;
    } else failed = outcome.failed;
    const command = this.#timeOperands.get(expression);
    this.#report(
      mixesDurationAndNumber(operator, failed)
        ? typeCode.mixedDurationOperands
        : typeCode.invalidOperand,
      (command === undefined ? null : groupedUnitMessage(command, expression, failed)) ??
        operatorMessage(operator, expression, failed, (item) => this.#typeOf(item)),
      expression.span,
    );
    return UNKNOWN_TYPE;
  }

  /**
   * For a value of unknown type from an operation, the types the operation could give when none of them fits a place of
   * type `type`, as text never comes from `/`. An operand of unknown type stands for every type an operator takes.
   */
  #unfitResults(
    expression: Expression,
    value: StaticType,
    type: StaticType,
  ): { readonly operator: string; readonly results: StaticType } | undefined {
    const operated = unwrap(expression);
    if (isKnown(value) || !isKnown(type)) return undefined;
    if (operated.kind !== "binaryExpression" && operated.kind !== "unaryExpression")
      return undefined;
    const results = this.#unknownOperations.get(operated);
    if (
      results === undefined ||
      results.length === 0 ||
      results.some((result) => mayFit(type, result))
    )
      return undefined;
    return { operator: operated.operator, results: union(results) };
  }

  /**
   * Reports a value from an operation that gives no type that fits the place (see {@link #unfitResults}), and returns
   * whether it did.
   */
  #reportUnfit(place: Place, expression: Expression, value: StaticType): boolean {
    const unfit = this.#unfitResults(expression, value, place.type);
    if (unfit === undefined) return false;
    const text = operationText(expression);
    // Another place suggests the type the operator gives for numbers, which is what such a value usually holds.
    const results = members(unfit.results);
    const fix = members(resolved(nonNullType(place.type))).some((member) =>
      isScalar(member, "string"),
    )
      ? text === null
        ? ' To show it as text, put the whole calculation inside "${" and "}".'
        : ` To show it as text, write "\${${text}}".`
      : place.fix(results.find((result) => isNumeric(result)) ?? results[0]!, expression);
    this.#report(
      typeCode.typeMismatch,
      `${place.subject}, so it cannot ${place.verb} the result of '${unfit.operator}', which is ${describeValue(unfit.results)}.${fix}`,
      expression.span,
    );
    return true;
  }

  /**
   * The types an operation of unknown result can give: every combination of its operands' members, where an operand of
   * unknown type stands for what the operation that gives it can give, or else for every type an operator takes. With
   * an operand that such an operation gives, also the operand types this used, for the message when none works.
   */
  #possibleResults(
    operands: readonly StaticType[],
    expression: Extract<Expression, { kind: "unaryExpression" | "binaryExpression" }>,
    result: (...values: StaticType[]) => StaticType | undefined,
  ): {
    readonly results: readonly StaticType[];
    readonly narrowed: readonly StaticType[] | null;
    readonly failed: boolean;
  } {
    const expressions =
      expression.kind === "binaryExpression"
        ? [expression.left, expression.right]
        : [expression.operand];
    let narrowed = false;
    // An operand that is an operation the check did not record already reported why it fails.
    let failed = false;
    const [lefts, rights] = operands.map((operand, index) =>
      members(resolved(nonNullTypeForUse(operand))).flatMap((member) => {
        if (isKnown(member)) return [member];
        const operation = unwrap(expressions[index]!);
        const given = this.#unknownOperations.get(operation);
        if (given === undefined) {
          failed ||= operation.kind === "binaryExpression" || operation.kind === "unaryExpression";
          return OPERAND_KINDS;
        }
        narrowed = true;
        return given;
      }),
    );
    const results: StaticType[] = [];
    for (const left of lefts!)
      for (const right of rights ?? [undefined]) {
        const type = right === undefined ? result(left) : result(left, right);
        if (type !== undefined && !results.some((known) => sameType(known, type)))
          results.push(type);
      }
    return {
      results,
      failed,
      narrowed:
        narrowed && !failed
          ? [lefts!, rights].flatMap((side) => (side === undefined ? [] : [union(side)]))
          : null,
    };
  }

  /**
   * Runs `check` for an operation whose operands in `slots` so far held only null, and keeps what it reports for the
   * end of the check instead of reporting it now.
   */
  #deferNullOnly(slots: readonly OpenType[], check: () => void): void {
    const before = this.diagnostics.length;
    check();
    const found = this.diagnostics.splice(before);
    if (found.length > 0)
      this.#deferred.push({
        kind: "nullOnly",
        file: this.#file,
        at: before,
        slots,
        diagnostics: found,
      });
  }

  /** Notes a property access, also by `+=` or `-=` (see {@link #noteMissingProperty}). */
  #noteMissingAccess(read: PropertyAccessExpression, object: StaticType): void {
    const name = read.property.name;
    this.#noteMissingProperty(
      read,
      name,
      object,
      read.property.span,
      (properties) =>
        missingPropertyMessage(expressionLabel(read.object), name, properties) +
        misspelledPropertyHint(name, properties),
    );
  }

  /**
   * Notes a read of the property `name` from a value of type `object` at `site`. When every value it may be is an
   * object whose properties the compiler knows, and none has the property, the end of the check reports `message` at
   * `span` if no object at that place can have it when the script runs (#845); a message that names the properties the
   * objects can have is a function of them. Any other read the runtime checks (TSR017, or TSR060 for a list function).
   */
  #noteMissingProperty(
    site: Expression,
    name: string,
    object: StaticType,
    span: SourceSpan,
    message: string | ((properties: readonly string[]) => string),
  ): void {
    // A read from a speaker is noted by `#noteSpeakerRead`.
    if (resolved(object).kind === "speaker") return;
    const objects = members(object).map(resolved);
    const tables = objects.flatMap((member) =>
      member.kind === "object" && member.properties !== null && !member.properties.has(name)
        ? [member.properties]
        : [],
    );
    this.#noteMissingIn(site, name, tables.length < objects.length ? null : tables, span, message);
  }

  /**
   * Notes a read of the property `name` at `site` from objects of `tables`, which lack it so far, or from a value that
   * may have it, for `null` (see {@link #noteMissingProperty}).
   */
  #noteMissingIn(
    site: Expression,
    name: string,
    tables: PropertyTable[] | null,
    span: SourceSpan,
    message: string | ((properties: readonly string[]) => string),
  ): void {
    const noted = this.#missingReads.get(site);
    if (tables === null) {
      if (noted !== undefined) this.#missingReads.set(site, null);
    } else if (noted === undefined) {
      this.#missingReads.set(site, { name, tables, named: typeof message !== "string" });
      this.#deferred.push({
        kind: "property",
        file: this.#file,
        at: this.diagnostics.length,
        site,
        span,
        message,
      });
    } else if (noted !== null) for (const table of tables) noted.tables.push(table);
  }

  /**
   * Reports the checks of {@link #deferred} that fail at the end of the check, at the place among the other diagnostics
   * of their file where they would have been reported: operations whose operands held only null to the end, and stores
   * that no result of their operation could fit once a later value decided the place's type.
   */
  #reportDeferred(): void {
    const known = new Map<OpenType, boolean>();
    const byFile = new Map<
      number,
      { readonly at: number; readonly found: readonly Diagnostic[] }[]
    >();
    const current = this.#file;
    // Every store, copy, and decision is known now, so it decides which properties the objects of a read can have.
    const sites: Expression[] = [];
    const checked: PropertyRead[] = [];
    for (const [site, read] of this.#missingReads)
      if (read !== null) {
        sites.push(site);
        checked.push(read);
      }
    const verdicts = missingPropertyReads(checked);
    const missing = new Map(sites.map((site, index) => [site, verdicts[index]]));
    // What some speaker gets, for reads from a speaker the compiler cannot tell apart, once the first needs it.
    let anySpeaker: ReadonlySet<string> | undefined;
    for (const check of this.#deferred) {
      let found: readonly Diagnostic[] = [];
      if (check.kind === "nullOnly") {
        if (check.slots.every((slot) => heldOnlyNull(slot, known))) found = check.diagnostics;
      } else if (check.kind === "speakerField") {
        anySpeaker ??= new Set([...this.#speakerGets.values()].flatMap((gets) => [...gets]));
        if (!this.#getsField(check.speaker, check.name, anySpeaker)) {
          this.#file = check.file;
          const before = this.diagnostics.length;
          this.#report(
            typeCode.invalidOperand,
            missingSpeakerPropertyMessage(
              {
                speaker: check.speaker ?? this.#onlySpeaker(),
                name: check.name,
                sources: fieldSources(check.name),
                example: check.speaker ?? this.#exampleSpeaker(),
              },
              { kind: "never", properties: [], names: [] },
            ),
            check.span,
          );
          found = this.diagnostics.splice(before);
        }
      } else if (check.kind === "property") {
        const names = missing.get(check.site);
        if (names !== undefined) {
          this.#file = check.file;
          const before = this.diagnostics.length;
          const { message } = check;
          this.#report(
            typeCode.invalidOperand,
            typeof message === "string" ? message : message(names),
            check.span,
          );
          found = this.diagnostics.splice(before);
        }
      } else {
        // The message names lines as seen from the store's file.
        this.#file = check.file;
        const before = this.diagnostics.length;
        if (this.#reportUnfit(check.place, check.expression, check.value))
          found = this.diagnostics.splice(before);
      }
      if (found.length === 0) continue;
      const reports = byFile.get(check.file) ?? [];
      reports.push({ at: check.at, found });
      byFile.set(check.file, reports);
    }
    this.#file = current;
    for (const [file, reports] of byFile) {
      const diagnostics = this.fileDiagnostics[file]!;
      const merged: Diagnostic[] = [];
      let next = 0;
      for (const report of reports) {
        for (; next < report.at; next += 1) merged.push(diagnostics[next]!);
        for (const diagnostic of report.found) merged.push(diagnostic);
      }
      for (; next < diagnostics.length; next += 1) merged.push(diagnostics[next]!);
      this.fileDiagnostics[file] = merged;
    }
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
    operator?: string,
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
        this.#reportMayBe(
          expressions[index]!,
          failing,
          passing,
          operator !== undefined && mixesDurationAndNumber(operator, failed)
            ? typeCode.mixedDurationOperands
            : typeCode.invalidOperand,
        );
        return { type: UNKNOWN_TYPE };
      }
    }
    return { failed };
  }

  /**
   * The arguments of a call of a built-in function or a method, each as it was evaluated, before later arguments run; a
   * `default:` that runs only when the call needs it comes last (owner decision, 2026-10-16). A call that `waits` for the
   * Player waits after its other arguments, so a block may run before its result or its default.
   */
  *#callArgumentsTask(
    expression: CallExpression,
    scope: Scope,
    waits = false,
  ): CompileTask<readonly StaticType[]> {
    const lazy = lazyDefaultArgument(expression)?.argument;
    const values: StaticType[] = [];
    for (const [index, argument] of expression.arguments.entries()) {
      if (argument === lazy) continue;
      yield* compileChild(this.#expressionTask(argument.value, scope));
      values[index] = this.#capture(argument.value);
    }
    if (waits) this.#suspend();
    if (lazy !== undefined) {
      yield* compileChild(this.#mayRunTask(lazy.value, scope));
      values[expression.arguments.indexOf(lazy)] = this.#capture(lazy.value);
    }
    return values;
  }

  /** An operand that runs only on some ways, such as a default: what it changes may or may not have happened after it. */
  *#mayRunTask(expression: Expression, scope: Scope): CompileTask<StaticType> {
    const start = this.#flow.mark();
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    const changes = this.#flow.undo(start);
    this.#flow.apply(this.#flow.join([new Map(), changes]));
    return type;
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
    if (isAskImageCall(expression)) {
      const answer = yield* compileChild(this.#askImageTask(expression, scope));
      // Like an interaction, it waits for the player.
      this.#suspend();
      return answer;
    }
    if (callee.kind === "identifier") {
      const entry = scope.resolve(callee.name);
      if (entry?.kind === "function")
        return yield* compileChild(this.#functionCallTask(expression, entry.fn, scope));
      // A file store or lock call may wait for the Player.
      const values = yield* compileChild(
        this.#callArgumentsTask(
          expression,
          scope,
          isFileStoreCall(expression) || isLockCall(expression),
        ),
      );
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
    if (method === "copyFrom") return yield* compileChild(this.#copyFromTask(expression, scope));
    // A method that changes a list, set, or dict, or reorders a list, changes its receiver.
    if (COLLECTION_CHANGES.has(method) || LIST_REORDERS.has(method))
      this.#noteChanged(callee.object);
    if (
      (method === "add" || method === "addAll" || method === "get") &&
      unwrap(callee.object).kind !== "identifier"
    )
      this.#relaxNarrowedRoot(callee.object, scope);
    const receiver = yield* compileChild(this.#expressionTask(callee.object, scope));
    if (method === "add" || method === "addAll") this.#noteUncheckedStore(callee.object, scope);
    // Text `reverse` gives a new text, so a receiver that cannot be a list is not changed and may take a fallback.
    if (method === "reverse" && !mayBe(receiver, "list")) this.#changed.delete(callee.object);
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
      if (argument?.kind === "positionalArgument" && expression.arguments.length === 1) {
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
      if (argument?.kind === "positionalArgument" && expression.arguments.length === 1) {
        yield* compileChild(
          this.#addAllTask(expression, callee.object, receiver, argument.value, scope),
        );
        return NULL_TYPE;
      }
    }
    const values = yield* compileChild(this.#callArgumentsTask(expression, scope));
    // Only a list has removeAt, so its position is a list index on any receiver; a list checks it with its other index
    // rules below.
    const listReceiver = values.length === 1 && isKnown(value) && members(value).every(isList);
    if (
      method === "removeAt" &&
      !listReceiver &&
      expression.arguments.length === 1 &&
      expression.arguments[0]!.kind === "positionalArgument"
    )
      this.#checkNegativeIndex(expression.arguments[0]!.value);
    if (!isKnown(value)) {
      // Only text and lists have these methods, so their arguments are checked on any receiver.
      memberChecks();
      // A value of unknown type has no written element type either (#511 C2).
      if (method === "add")
        for (const argument of expression.arguments)
          this.#reportMixedChoice(argument.value, () => ONE_TYPE_FIX);
      return UNKNOWN_TYPE;
    }
    if (method === "removeAt" && listReceiver)
      this.#checkIndex(value, callee.object, values[0]!, expression.arguments[0]!.value);
    // As for a dict, the default may decide the element type of a list that no value decided yet (V30 §16), before
    // anything reads the element.
    const listDefault = expression.arguments[1];
    if (
      method === "get" &&
      expression.arguments.length === 2 &&
      expression.arguments[0]!.kind === "positionalArgument" &&
      listDefault?.kind === "namedArgument" &&
      listDefault.name.name === "default" &&
      members(nonNullType(value)).every(isList)
    )
      yield* compileChild(
        this.#defaultDecidesTask(
          expression,
          callee.object,
          receiver,
          listDefault.value,
          values[1]!,
          scope,
          "list",
        ),
      );
    // A list's `get` takes its index as indexing does, but gives its default for a negative one (#844). A member without
    // `get`, such as null, is reported below instead, and a dict, which has one, here, as for indexing.
    if (
      method === "get" &&
      expression.arguments[0]?.kind === "positionalArgument" &&
      members(value).some(isList) &&
      members(value).every((member) => memberMethodType(member, method) !== undefined)
    )
      this.#checkIndex(value, callee.object, values[0]!, expression.arguments[0].value, true);
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
        // The default may be of any type, and the result joins it with the value type (V30 §40).
        yield* compileChild(
          this.#defaultDecidesTask(
            expression,
            callee.object,
            receiver,
            defaultArgument.value,
            fallback,
            scope,
            "dict",
          ),
        );
      }
    } else if (
      (method === "contains" || method === "remove") &&
      expression.arguments.length === 1 &&
      members(nonNullType(value)).some((member) => isDict(resolved(member)))
    )
      // On a union with a dict, the dict takes a text key as well (ADR 0021 rule 3.5).
      this.#checkDictKey(values[0]!, expression.arguments[0]!.value);
    // A range written in the call gives its whole numbers, as `for` does, but at most 1,000,000 of them (V30 §6).
    if (method === "toList") {
      this.#checkWholeRangeBounds(callee.object, "toList()");
      this.#checkRangeListLength(callee.object);
      // A call with arguments is an error, which says enough.
      if (expression.arguments.length === 0)
        this.#warnEmptyRange(callee.object, "toList() returns []");
    }
    // Every member of a union must have the method (ADR 0021 rule 3.5). A speaker has no methods (V30 §37), and where
    // another member has the method, the runtime checks a speaker.
    const all = members(value);
    const typed = all.map((member) => memberMethodType(member, method));
    const elsewhere = all.some(
      (member, index) => typed[index] !== undefined && resolved(member).kind !== "speaker",
    );
    const results = elsewhere
      ? typed
      : all.map((member, index) =>
          resolved(member).kind === "speaker" ? undefined : typed[index],
        );
    const passing = all.filter((_, index) => results[index] !== undefined);
    if (passing.length === all.length) {
      const handle = resolved(all[0]!).kind;
      const handles = all.every((member) => hasArgumentlessMethods(resolved(member).kind));
      if (handles && hasArgumentlessMethods(handle) && expression.arguments.length > 0)
        this.#report(
          handleMemberCode(handle),
          handleArgumentsMessage(handle, method),
          callee.property.span,
        );
      const textual = TEXT_MEMBERS.has(method) || method === "join";
      const collection = all.some((member) => {
        const kept = resolved(member);
        return isListOrSet(kept) || kept.kind === "dict" || kept.kind === "range";
      });
      if (textual || COLLECTION_METHODS.has(method) || collection) {
        // Each member takes the arguments as the one receiver would (ADR 0021 rule 3.5), and the results join. A problem
        // that several members share at one place is reported once.
        const before = this.diagnostics.length;
        const atCall = members(resolved(receiverAtCall));
        // A message or a permanent button takes `remove()` without arguments, which a list, set, or dict member rejects.
        const removable = mayBe(receiver, "messageHandle", "permanentButton");
        const memberResults = all.map((member, index) => {
          const kept = resolved(member);
          // A list or set checks its own methods, also `indexOf`, `lastIndexOf`, and `count`, which take any value on a
          // list.
          if (isListOrSet(kept) && COLLECTION_METHODS.has(method))
            return this.#collectionMethodType(method, kept, callee.property, expression, scope);
          // Its other methods, a dict's in a union, and a range's `toList` take their arguments without names, in their
          // number (V30 §16).
          if (isListOrSet(kept) || kept.kind === "dict" || kept.kind === "range")
            this.#reportProblems(positionalMethodProblems(method, expression, removable));
          if (textual)
            this.#reportProblems(
              memberProblems(
                callee.object,
                atCall[index] ?? member,
                callee.property,
                expression,
                typeOf,
              ),
            );
          if (fallback === undefined) return results[index]!;
          // A dict gives the value or the default, so their types join as in a literal, where an empty list default
          // takes the element type of a list value, and a default of another type adds its type. A default of unknown
          // type makes the result unknown, so a place checks it when the script runs.
          const both = [results[index]!, plainType(fallback)];
          return joinTypes(both) ?? union(both);
        });
        this.#keepFirstDiagnostics(before);
        return memberResults.length === 1 ? memberResults[0]! : union(memberResults);
      }
      // The methods of date and time values take no arguments; a format follows the player's settings.
      if (all.every(isTemporal) && expression.arguments.length > 0)
        this.#report(
          typeCode.argumentCount,
          temporalArgumentsMessage(method, expression.arguments.length),
          callee.property.span,
        );
      return all.length === 1 ? results[0]! : union(results.map((result) => result!));
    }
    const failing = resolved(all.find((_, index) => results[index] === undefined)!);
    if (passing.length > 0) this.#reportMayBe(callee.object, failing, passing);
    // Text operations and values without methods name what to write instead (V30 §8).
    else if (all.length === 1 && MEMBER_CHECKED_KINDS.has(failing.kind)) memberChecks();
    // A set has no order to sort, shuffle, reverse, or take from, and no positions or repeated members to search for
    // (V30 §16).
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
        handleMemberCode(failing.kind),
        failing.kind === "list" || failing.kind === "set"
          ? `${failing.kind === "list" ? "Lists" : "Sets"} have no method '${method}'.`
          : failing.kind === "dict"
            ? method === "add"
              ? "Dicts have no method 'add'. Store a value by its key, as in dict[key] = value."
              : `Dicts have no method '${method}'. Use contains, remove, clear, or get.`
            : failing.kind === "timer" ||
                failing.kind === "media" ||
                failing.kind === "camera" ||
                failing.kind === "messageHandle"
              ? handleMemberMessage(failing.kind, method, "call")
              : failing.kind === "permanentButton"
                ? `Permanent buttons have no method '${method}'. Use remove().`
                : failing.kind === "speaker" && all.length === 1
                  ? speakerMethodMessage(method, expressionLabel(callee.object))
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
        : members(type).some((member) => resolved(member).kind === "range")
          ? RANGE_LIST_FIX
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
   * Checks `sort`, `shuffle`, `reverse`, `take`, `takeLast`, a search, `get`, or a set operation on one list or set, as
   * evaluated, and gives its result (V30 §16).
   */
  #collectionMethodType(
    method: string,
    value: StaticType & { readonly kind: "list" | "set" },
    property: Identifier,
    expression: CallExpression,
    scope: Scope,
  ): StaticType {
    const typeOf = (argument: Expression): StaticType => this.#typeOf(argument);
    const problems = collectionMethodProblems(method, value, property, expression, typeOf);
    this.#reportProblems(problems);
    if (LIST_REORDERS.has(method)) return NULL_TYPE;
    if (method === "take" || method === "takeLast")
      return { kind: "list", element: copyType(value.element) };
    if (LIST_SEARCHES.has(method)) return memberMethodType(value, method) ?? UNKNOWN_TYPE;
    // The element, or the default, which may be of another type, so their types join (#844). Where the default has a
    // part that no value decided yet, such as `[]`, they join as in a literal, so that part takes the element type, as
    // for a dict (#853). An element type that is still undecided, such as where a null default decided nothing, keeps
    // the plain union.
    if (method === "get") {
      const fallback = expression.arguments.find((argument) => argument.kind === "namedArgument");
      if (problems.length > 0 || fallback === undefined) return UNKNOWN_TYPE;
      const element = ownNull(copyType(value.element));
      const other = plainType(typeOf(fallback.value));
      const undecided = (type: StaticType): boolean =>
        containsType(type, (part) => part.kind === "open");
      const joined =
        undecided(other) && !undecided(element) ? joinTypes([element, other]) : undefined;
      return joined ?? union([element, other]);
    }
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
    return this.#setOperationType(method, value, expression, problems.length === 0, scope);
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
    scope: Scope,
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
        const declared =
          callee.kind === "propertyAccessExpression"
            ? this.#declaredOf(callee.object, scope)
            : null;
        this.#reportMixedJoin("union()", receiver.kind, own, other, declared, expression.span);
      }
      return { kind: receiver.kind, element: UNKNOWN_TYPE };
    }
    return { kind: receiver.kind, element };
  }

  /**
   * Reports an operation that would give a list or set the elements of two collections whose types mix, such as
   * `union()` or `+`. As for a mixed literal, the fix declares the collection that `declared` names with a union
   * element type.
   */
  #reportMixedJoin(
    operation: string,
    kind: "list" | "set",
    own: StaticType,
    other: StaticType,
    declared: Declared,
    span: SourceSpan,
    note = "",
  ): void {
    const mixed: StaticType = { kind, element: union([own, other]) };
    const written = typeName(mixed);
    const property = misfitProperty(own, other);
    const fix =
      property !== undefined
        ? `give '${property.name}' one type in every element`
        : (unnamedMixFix(mixed) ?? keepBothFix(declared, written));
    this.#report(
      typeCode.mixedTypes,
      `${operation} would mix ${mixDescription(own, other)}.${note} A ${kind} holds one type. ${capitalize(fix)}.`,
      span,
    );
  }

  /**
   * Checks the arguments of a numeric function and gives its result type (V30 §13). A call whose arguments the compiler
   * can see and that has no finite result is a compile error.
   */
  #numericFunctionType(
    name: string,
    expression: CallExpression,
    values: readonly StaticType[],
  ): StaticType {
    const numeric = NUMERIC_FUNCTIONS.get(name)!;
    const problems = builtinCallProblems(name, expression, (item) => this.#typeOf(item));
    const fitting = problems.every((problem) => problem.kind === "invalidOperand");
    // An argument that may be one of several types, or null, names the test or the check first (ADR 0021 rule 3.5,
    // #504 Q1).
    const several = fitting
      ? expression.arguments.flatMap((item, index) =>
          members(values[index]!).length > 1 ? [{ item, type: values[index]! }] : [],
        )
      : [];
    const spans = new Set(several.map(({ item }) => item.value.span.start.offset));
    this.#reportProblems(problems.filter((problem) => !spans.has(problem.span.start.offset)));
    for (const { item, type } of several)
      this.#reportUnless(type, isNumeric, item.value, `${name}(...) takes a number`);
    const input = (item: CallArgument | undefined, index: number): NumericArgument => {
      if (item === undefined || !fitting) return { type: "unknown", known: undefined };
      const parts = members(nonNullTypeForUse(values[index]!));
      const known = this.#known(item.value);
      return {
        type:
          parts.length === 0 || !parts.every(isNumeric)
            ? "unknown"
            : parts.every((part) => isScalar(part, "integer"))
              ? "integer"
              : "number",
        known: typeof known === "number" ? known : undefined,
      };
    };
    const positional = expression.arguments.filter((item) => item.kind === "positionalArgument");
    const inputs = numeric.parameters.map((_, index) =>
      input(positional[index], expression.arguments.indexOf(positional[index]!)),
    );
    const named: Record<string, NumericArgument> = {};
    expression.arguments.forEach((item, index) => {
      if (item.kind === "namedArgument") named[item.name.name] = input(item, index);
    });
    const all = [...inputs, ...Object.values(named)];
    if (problems.length === 0 && all.every((one) => one.known !== undefined)) {
      const known = inputs.map((one) => one.known!);
      // A random result is never computed here; only its arguments are checked.
      const result =
        numeric.random !== undefined
          ? numeric.random(known)
          : numeric.apply(
              known,
              Object.fromEntries(Object.entries(named).map(([key, one]) => [key, one.known!])),
              () => {
                throw new Error(`${name}(...) draws no random numbers.`);
              },
            );
      if (result !== undefined && typeof result !== "number")
        this.#report(typeCode.invalidOperand, result.failure, expression.span);
    }
    const result = numeric.result(inputs, named);
    return result === "integer" ? INTEGER_TYPE : result === "number" ? NUMBER_TYPE : UNKNOWN_TYPE;
  }

  /**
   * Checks the arguments of an angle function and gives its result type (V30 §13). A plain number where an angle is
   * needed names the unit to write, and a call whose arguments the compiler can see and that has no result is a compile
   * error.
   */
  #angleFunctionType(
    name: string,
    expression: CallExpression,
    values: readonly StaticType[],
  ): StaticType {
    const angleFunction = ANGLE_FUNCTIONS.get(name)!;
    const problems = builtinCallProblems(name, expression, (item) => this.#typeOf(item));
    const takes = (member: StaticType): boolean =>
      angleFunction.takes === "angle" ? isScalar(member, "angle") : isNumeric(member);
    // An argument that may be one of several types, or null, names the test or the check first (ADR 0021 rule 3.5).
    const several = problems.every((problem) => problem.kind === "invalidOperand")
      ? expression.arguments.flatMap((item, index) =>
          members(values[index]!).length > 1 ? [{ item, type: values[index]! }] : [],
        )
      : [];
    const spans = new Set(several.map(({ item }) => item.value.span.start.offset));
    this.#reportProblems(problems.filter((problem) => !spans.has(problem.span.start.offset)));
    for (const { item, type } of several)
      this.#reportUnless(
        type,
        takes,
        item.value,
        `${name}(...) takes ${angleFunction.takes === "angle" ? "an angle" : "a number"}`,
      );
    if (problems.length === 0) {
      const known = expression.arguments.map((item) => this.#known(item.value));
      const fits = (value: StaticScalar | undefined): value is number | StoredAngle =>
        angleFunction.takes === "angle"
          ? value !== null && typeof value === "object" && value.kind === "angle"
          : typeof value === "number";
      if (known.every(fits)) {
        const result = angleFunction.apply(known);
        if (typeof result !== "number" && "failure" in result)
          this.#report(typeCode.invalidOperand, result.failure, expression.span);
      }
    }
    return angleFunction.returns === "angle" ? ANGLE_TYPE : NUMBER_TYPE;
  }

  /** Argument and result types of the implemented built-ins; injected host functions return unknown values. */
  #builtinType(
    name: string,
    expression: CallExpression,
    values: readonly StaticType[],
  ): StaticType {
    if (NUMERIC_FUNCTIONS.has(name)) return this.#numericFunctionType(name, expression, values);
    if (ANGLE_FUNCTIONS.has(name)) return this.#angleFunctionType(name, expression, values);
    // `min` and `max` of one argument that may be a list are list functions too (V30 §16).
    const positional = expression.arguments.filter((item) => item.kind === "positionalArgument");
    const list =
      positional.length === 1 &&
      members(nonNullTypeForUse(this.#typeOf(positional[0]!.value))).some(
        (member) => !isKnown(member) || resolved(member).kind === "list",
      );
    if (LIST_FUNCTIONS.has(name) || (MIN_MAX_NAMES.has(name) && list)) {
      // An argument that may be null names the check first (ADR 0021 rule 1.9); the checks below use its other members.
      expression.arguments.forEach((item, index) => {
        const all = members(values[index]!);
        const passing = all.filter((member) => member.kind !== "null");
        if (passing.length > 0 && passing.length < all.length)
          this.#reportMayBe(item.value, NULL_TYPE, passing);
      });
      const check = listFunctionCheck(
        name,
        expression,
        (item) => this.#typeOf(item),
        (item) => {
          const known = this.#known(item);
          return typeof known === "number" ? known : undefined;
        },
      );
      this.#reportProblems(check.problems);
      for (const read of check.reads)
        this.#noteMissingProperty(read.at, read.name, read.objects, read.at.span, read.message);
      return check.type;
    }
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
        if (argument !== undefined && value !== undefined) {
          this.#reportUnless(
            value,
            isNumeric,
            argument.value,
            "chance(...) takes a percentage number",
          );
          // A percentage the compiler can see is checked as the runtime checks it.
          const known = this.#known(argument.value);
          const failure = typeof known === "number" ? percentageFailure(name, known) : undefined;
          if (failure !== undefined)
            this.#report(typeCode.invalidOperand, failure, argument.value.span);
        }
        return BOOLEAN_TYPE;
      case "randomInteger":
        if (argument !== undefined && value !== undefined) {
          this.#reportUnless(
            value,
            (member) => member.kind === "range",
            argument.value,
            "randomInteger(...) takes a range such as 1..=6",
          );
          if (argument.kind === "positionalArgument")
            this.#checkDrawnRange(argument.value, "randomInteger(range)");
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
              : isScalar(member, "calendarDuration")
                ? "calendar durations"
                : isScalar(member, "angle")
                  ? "angles"
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
        // Known calendar durations must share one family, also those that would not win (ADR 0026).
        const knownFamilies = new Set(
          expression.arguments.map((item) => {
            const value = this.#known(item.value);
            return isStaticDuration(value) && isCalendar(value)
              ? durationFamily(durationParts(value))
              : "zero";
          }),
        );
        knownFamilies.delete("zero");
        if (knownFamilies.size > 1 || knownFamilies.has("mixed"))
          this.#report(
            typeCode.invalidOperand,
            `${name}(...) compares calendar durations of one kind only: months, days, or exact time.`,
            expression.span,
          );
        for (const item of several)
          this.#reportUnless(
            this.#typeOf(item.value),
            (member) => familyOf(member) !== undefined && familyOf(member) === family,
            item.value,
            `${name}(...) needs values of one kind: all numbers, all durations, all calendar durations, all angles, or all dates, times, datetimes, or absolute dates and times`,
          );
        // The result is an integer when every argument is one, like arithmetic on them (ADR 0021 rule 2.2).
        const numbers = values.map(nonNullTypeForUse);
        if (numbers.length < 2) return UNKNOWN_TYPE;
        if (numbers.every((number) => isScalar(number, "duration"))) return DURATION_TYPE;
        if (numbers.every((number) => isScalar(number, "calendarDuration")))
          return CALENDAR_DURATION_TYPE;
        if (numbers.every((number) => isScalar(number, "angle"))) return ANGLE_TYPE;
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
      case "toAbsoluteDateTime":
        this.#reportProblems(builtinCallProblems(name, expression, (item) => this.#typeOf(item)));
        return scalarType(CONVERSION_RESULTS.get(name)!);
      case "toJson":
      case "fromJson":
      case "toBase64":
      case "fromBase64":
      case "fileFromBase64":
      case "fileToBase64":
      case "hashText":
      case "hashFile": {
        // The JSON or Base64 text of a value or a stored file, what such text holds, and the SHA-256 of text or a stored
        // file (V30 §13 and §33).
        const problems = builtinCallProblems(name, expression, (item) => this.#typeOf(item));
        this.#reportProblems(problems);
        if (
          (name === "toBase64" ||
            name === "fileToBase64" ||
            name === "hashText" ||
            name === "hashFile") &&
          problems.length === 0
        )
          this.#reportUnless(
            value!,
            (member) => isScalar(member, "string"),
            argument!.value,
            name === "toBase64"
              ? "toBase64(...) encodes text (string)"
              : name === "hashText"
                ? "hashText(...) hashes text (string)"
                : name === "hashFile"
                  ? "hashFile(...) hashes a stored file, which is text (string)"
                  : "fileToBase64(...) reads a stored file, which is text (string)",
          );
        // What JSON holds is known only when the script runs; Base64 holds text, a stored file is named by text, a hash
        // is text, or the result is the default.
        if (name === "fromJson") return UNKNOWN_TYPE;
        const fallback = expression.arguments.findIndex(
          (item) => item.kind === "namedArgument" && item.name.name === "default",
        );
        return (name === "fromBase64" || name === "fileFromBase64") && fallback !== -1
          ? union([STRING_TYPE, values[fallback]!])
          : STRING_TYPE;
      }
      case "encryptText":
      case "encryptFile":
      case "decryptText":
      case "decryptFile": {
        // Locked text as Base64 or a locked stored file, and what a lock opens to, or the default (V30 §13).
        const problems = builtinCallProblems(name, expression, (item) => this.#typeOf(item));
        this.#reportProblems(problems);
        const index = expression.arguments.findIndex((item) => item.kind === "positionalArgument");
        if (index !== -1 && problems.every((problem) => problem.kind !== "argumentCount"))
          this.#reportUnless(
            values[index]!,
            (member) => isScalar(member, "string"),
            expression.arguments[index]!.value,
            name === "encryptText"
              ? "encryptText(...) locks text (string)"
              : name === "decryptText"
                ? "decryptText(...) opens locked text (string)"
                : `${name}(...) ${name === "encryptFile" ? "locks" : "opens"} a stored file, which is text (string)`,
          );
        const fallback = expression.arguments.findIndex(
          (item) => item.kind === "namedArgument" && item.name.name === "default",
        );
        return fallback !== -1 ? union([STRING_TYPE, values[fallback]!]) : STRING_TYPE;
      }
      case "toRegex": {
        // A regex from pattern text, or the default, a regex or null (V30 §8).
        this.#reportProblems(builtinCallProblems(name, expression, (item) => this.#typeOf(item)));
        const fallback = expression.arguments.findIndex(
          (item) => item.kind === "namedArgument" && item.name.name === "default",
        );
        const fallbackType = fallback === -1 ? undefined : values[fallback]!;
        return fallbackType !== undefined &&
          isKnown(fallbackType) &&
          isAssignable(optional(REGEX_TYPE), fallbackType)
          ? union([REGEX_TYPE, fallbackType])
          : optional(REGEX_TYPE);
      }
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
      case "getAbsoluteDateTime":
        // The current date and time take no arguments (V30 §35).
        if (expression.arguments.length > 0)
          this.#report(
            typeCode.argumentCount,
            temporalArgumentsMessage(name, expression.arguments.length),
            expression.arguments[0]!.value.span,
          );
        return name === "getDate"
          ? DATE_TYPE
          : name === "getTime"
            ? TIME_TYPE
            : name === "getDateTime"
              ? DATETIME_TYPE
              : ABSOLUTE_DATE_TIME_TYPE;
      case "script": {
        // `script(path)` or `script(path, label: name)`, both text (V30 §29).
        const positional = expression.arguments.filter(
          (item) => item.kind === "positionalArgument",
        ).length;
        if (positional !== 1)
          this.#report(
            typeCode.argumentCount,
            argumentCountMessage(
              "script",
              "1 argument (path)",
              positional,
              `Name a label with 'label:', as in 'script("rooms/hall.tease", label: "start")'.`,
            ),
            expression.span,
          );
        for (const [index, item] of expression.arguments.entries()) {
          if (item.kind === "namedArgument" && item.name.name !== "label")
            this.#report(
              typeCode.unknownNamedArgument,
              unknownNamedArgumentMessage("script", item.name.name, ["label"]),
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
    const all = members(object);
    const reads = all.map((member) => memberPropertyType(member, name));
    const passing = all.filter((_, index) => reads[index] !== undefined);
    if (passing.length === all.length) {
      this.#noteMissingAccess(expression, object);
      const types = reads.map((read) => (read!.kind === "placeRead" ? read!.type : read!));
      const type = all.length === 1 ? types[0]! : union(types);
      // A property or an element is read from the place that keeps it. Any other property gives a new value, such as a
      // copy of a set member (ADR 0014), so what changes it decides or widens nothing in the value it was read from.
      return reads.every((read) => read!.kind === "placeRead") ? placeRead(type) : copyType(type);
    }
    const failing = all.find((_, index) => reads[index] === undefined)!;
    if (passing.length > 0) {
      this.#reportMayBe(expression.object, failing, passing);
      return UNKNOWN_TYPE;
    }
    const value = resolved(failing);
    // An absolute date and time has no local fields until it is converted through the player's zone.
    if (isScalar(value, "absoluteDateTime") && temporalFieldType("datetime", name) !== undefined) {
      this.#report(
        typeCode.invalidOperand,
        `An absolute date and time has no property '${name}'. Convert it first, as in '${expressionLabel(expression.object) ?? "value"}.toDateTime().${name}'.`,
        expression.property.span,
      );
      return UNKNOWN_TYPE;
    }
    // An exact duration has no components: dividing it by a unit gives its number (ADR 0026).
    if (isScalar(value, "duration")) {
      this.#report(
        typeCode.invalidOperand,
        durationPropertyMessage(name, expressionLabel(expression.object) ?? "value"),
        expression.property.span,
      );
      return UNKNOWN_TYPE;
    }
    if (isScalar(value, "calendarDuration")) {
      this.#report(
        typeCode.invalidOperand,
        `A calendar duration has no property '${name}'. Use months, days, or exactOffset.`,
        expression.property.span,
      );
      return UNKNOWN_TYPE;
    }
    if (isScalar(value, "angle")) {
      this.#report(
        typeCode.invalidOperand,
        anglePropertyMessage(name, expressionLabel(expression.object) ?? "value"),
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
      handleMemberCode(value.kind),
      value.kind === "list" || value.kind === "set"
        ? `${value.kind === "list" ? "Lists" : "Sets"} have no property '${name}'. Use length, first, last, or random.`
        : value.kind === "dict"
          ? `Dicts have no property '${name}'. Use length, keys, or values. To read a value by its key, write '${expressionLabel(expression.object) ?? "dict"}[${JSON.stringify(name)}]'.`
          : value.kind === "timer" ||
              value.kind === "media" ||
              value.kind === "camera" ||
              value.kind === "messageHandle"
            ? handleMemberMessage(value.kind, name, "read")
            : `${capitalize(describeValue(value))} has no property '${name}'.`,
      expression.property.span,
    );
    return UNKNOWN_TYPE;
  }

  /**
   * Checks `object[index]`: only lists, indexed by a whole number, and dicts, by a text key, are indexed, and every
   * member of a union must be the same one. An object has fixed properties, so it points to a dict. A list index below
   * 0 is an error, but not for a list's `get` (`belowZero`), which gives its default for it; one that is not whole has
   * the error of that.
   */
  #checkIndex(
    object: StaticType,
    objectExpression: Expression,
    index: StaticType,
    expression: Expression,
    belowZero = false,
  ): void {
    const known = members(nonNullType(object)).filter(isKnown).map(resolved);
    // Also on a receiver that may be null or is not known: no list has an element below 0.
    if (
      !belowZero &&
      !isScalar(nonNullTypeForUse(index), "number") &&
      members(nonNullType(object)).some(
        (member) => !isKnown(member) || resolved(member).kind === "list",
      )
    )
      this.#checkNegativeIndex(expression);
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

  /** A list index the compiler knows is below 0, which no element has. */
  #checkNegativeIndex(expression: Expression): void {
    const known = this.#known(expression);
    if (typeof known === "number" && known < 0)
      this.#report(typeCode.invalidListIndex, NEGATIVE_INDEX_MESSAGE, expression.span);
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
        unknownNamedArgumentMessage(method, unknown.name.name, method === "get" ? ["default"] : []),
        unknown.name.span,
      );
      return false;
    }
    const keys = method === "clear" ? 0 : 1;
    if (positional.length === keys && (method !== "get" || named.length === 1)) return true;
    this.#report(
      typeCode.argumentCount,
      method === "get" && named.length === 0 && positional.length === 1
        ? missingDefaultMessage(
            "get(key, default: value)",
            "for a missing key",
            "Read a key that must exist as 'dict[key]'.",
          )
        : argumentCountMessage(
            method,
            method === "get"
              ? "1 argument (key) and a 'default:'"
              : method === "clear"
                ? "no arguments"
                : "1 argument (key)",
            positional.length,
          ),
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
    // The options of the question's mode are evaluated first, as for `say`.
    if (expression.presentation !== null)
      yield* compileChild(this.#expressionTask(expression.presentation, scope));
    if (expression.interactionKind === "form")
      return yield* compileChild(this.#formTask(expression, scope));
    if (expression.interactionKind === "booleans")
      return yield* compileChild(this.#askBooleansTask(expression, scope));
    if (expression.interactionKind === "boolean") {
      // Two buttons that return true and false, and the one `prefill:` names is preselected (V30 §20).
      for (const { name, value } of namedAskArguments(expression)) {
        const type = yield* compileChild(this.#expressionTask(value, scope));
        if (name === "prefill") this.#checkInteractionPrefill("boolean", value, type);
        else
          this.#checkShownText(
            value,
            type,
            name === "message" ? "an ask question" : "a button text",
          );
      }
      return BOOLEAN_TYPE;
    }
    if (expression.interactionKind !== "choice") {
      this.#checkPresentation(expression.presentation);
      for (const operand of askOperands(expression)) {
        if (operand === expression.presentation) continue;
        const type = yield* compileChild(this.#expressionTask(operand, scope));
        if (operand === expression.prefill)
          this.#checkInteractionPrefill(expression.interactionKind, operand, type);
        else
          this.#checkShownText(
            operand,
            type,
            operand === expression.hint ? "an input hint" : "an ask question",
          );
      }
      return interactionResultType(expression.interactionKind);
    }
    // `askChoice` returns a button's value: one written before `:`, or else what gives the button, with its type. Each
    // button's value is also kept when the source shows it, so a comparison with another value can be checked (C5).
    const values: StaticType[] = [];
    let literals: (ScalarValue | null)[] | null = [];
    const add = (type: StaticType, literal: ScalarValue | null | undefined): void => {
      values.push(type);
      if (literal === undefined) literals = null;
      else literals?.push(literal);
    };
    let buttons = 0;
    // Whether every option is a list or set written without elements.
    let empty = true;
    for (const option of expression.options) {
      const content = unwrap(option.expression);
      if (
        (content.kind !== "listLiteral" && content.kind !== "setLiteral") ||
        content.elements.length > 0
      )
        empty = false;
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
                "A choice list element must be text, a number, true, false, null, a duration, an angle, a date or time value, or a choice object { value?, text, background? }.",
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
    if (empty && expression.options.length > 0)
      this.#report(typeCode.invalidInteractionChoice, EMPTY_CHOICE_MESSAGE, expression.span);
    // The button whose value `prefill:` gives is preselected; a value no button has preselects none (V30 §19).
    if (expression.prefill !== null)
      yield* compileChild(this.#expressionTask(expression.prefill, scope));
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
   * Reports an `askChoice` whose buttons return values of different types where its value would decide a type, such as
   * an unannotated `let`, an inferred function result, or a parameter without a type (#511 C2).
   */
  #reportMixedChoice(expression: Expression, fix: (written: string) => string): void {
    const mixed = this.#mixedChoices.get(unwrap(expression));
    if (mixed === undefined) return;
    this.#report(
      typeCode.mixedTypes,
      `This askChoice returns ${describeValue(mixed)}. A place keeps one type. ${capitalize(unnamedMixFix(mixed) ?? fix(typeName(mixed)))}.`,
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
          : (unreturnableChoiceMessage(member) ??
              "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set."),
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
    // What a choice object written as a literal may hold; the runtime checks a computed one, whose properties may change.
    if (!literal.properties.some((property) => property.name.name === "text"))
      this.#report(typeCode.invalidInteractionChoice, CHOICE_TEXT_MESSAGE, literal.span);
    for (const property of literal.properties) {
      const name = property.name.name;
      if (!isChoiceObjectProperty(name))
        this.#report(
          typeCode.invalidInteractionChoice,
          choicePropertyMessage(name),
          property.name.span,
        );
      else if (name === "value" && !returns)
        this.#report(typeCode.invalidInteractionChoice, CHOICE_VALUES_MESSAGE, property.name.span);
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
              (member) => unreturnableChoiceMessage(member) === undefined,
              (member) =>
                this.#report(
                  typeCode.invalidInteractionChoice,
                  unreturnableChoiceMessage(member)!,
                  property.value.span,
                ),
            );
        }
      } else if (property.name.name === "value") {
        this.#checkMembers(property.value, propertyType, isChoiceValue, () =>
          this.#report(
            typeCode.invalidInteractionChoice,
            "A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value.",
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
              : `"\${...}" cannot show ${describeValue(member)}. It shows text, numbers, true, false, null, durations, angles, date and time values, script references, and regexes, and selects one element of a list.`,
            expression.span,
          ),
      );
      if (!reported)
        this.#checkElements(expression, type, isShowable, () =>
          this.#report(
            typeCode.unshowableValue,
            "An interpolated list may contain only text, numbers, true, false, null, durations, angles, date and time values, script references, and regexes, because one element is shown as text.",
            expression.span,
          ),
        );
      return;
    }
    if (value.elements.length === 0)
      this.#report(
        typeCode.unshowableValue,
        "'${...}' shows one random element of a list, but this list is empty. Check its length first.",
        value.span,
      );
    for (const element of value.elements)
      this.#checkMembers(element, this.#typeOf(element), isShowable, () =>
        this.#report(
          typeCode.unshowableValue,
          "An interpolated list may contain only text, numbers, true, false, null, durations, angles, date and time values, script references, and regexes, because one element is shown as text.",
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
        this.#reportNonDuration(
          option.value,
          type,
          "A showButton timeout is a duration",
          "30 s",
          () => unitFix(option.value),
        );
        this.#checkTimeoutLength("showButton", option.value);
      }
    }
  }

  /** Reports a known timeout of an interaction that cannot run: one of zero or less, or one beyond scene time. */
  #checkTimeoutLength(command: "showButton" | "askForm", value: Expression): void {
    const known = this.#knownLength(value);
    const problem =
      known === undefined
        ? undefined
        : !isTimeoutLength(known.milliseconds)
          ? timeoutLengthMessage(command, formatDuration(known))
          : !reachesSceneTime(known.milliseconds)
            ? timeoutSceneTimeMessage(command)
            : undefined;
    if (problem !== undefined) this.#report(typeCode.invalidRepeatCount, problem, value.span);
  }

  #checkBackground(expression: Expression, type: StaticType): void {
    if (
      this.#reportedMayBe(
        expression,
        type,
        (member) => isScalar(member, "string"),
        typeCode.invalidInteractionChoice,
      )
    )
      return;
    const value = nonNullType(type);
    const text = isScalar(type, "string") ? staticVisibleText(expression) : undefined;
    if (isKnown(value) && !isScalar(value, "string"))
      this.#report(
        typeCode.invalidInteractionChoice,
        buttonBackgroundMessage(describeValue(value)),
        expression.span,
      );
    else if (text !== undefined && !isButtonBackground(text))
      this.#report(
        typeCode.invalidInteractionChoice,
        buttonBackgroundMessage(describeShownValue(text)),
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
    code: TypeErrorCode = typeCode.invalidOperand,
  ): boolean {
    const all = members(nonNullType(type)).filter(isKnown);
    const passing = all.filter(accepts);
    if (passing.length === 0 || passing.length === all.length) return false;
    this.#reportMayBe(
      expression,
      all.find((member) => !accepts(member))!,
      passing,
      code,
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
   * A prefill must be an answer the field accepts: text for askText, a number for askNumber, and a whole number for
   * askInteger. One that is `null` or blank when the field opens prefills nothing, but one known here to be `null` or
   * blank is an error. The compiler rejects a prefill it knows is wrong; the runtime checks the others when the field
   * opens.
   */
  #checkInteractionPrefill(
    kind: Exclude<InteractionExpression["interactionKind"], "choice">,
    expression: Expression,
    type: StaticType,
  ): void {
    // A password is typed by the person who knows it, never suggested (V30 §20).
    if (kind === "password") {
      this.#report(
        typeCode.invalidOperand,
        "askPassword takes no 'prefill:', since a password is never suggested. Remove 'prefill:'.",
        expression.span,
      );
      return;
    }
    const name = expression.kind === "identifier" ? expression.name : null;
    const value = nonNullTypeForUse(type);
    const holds = !isKnown(type)
      ? ""
      : name === null
        ? `, not ${describeValue(type)}`
        : `, but '${name}' holds ${describeValue(type)}`;
    if (kind === "boolean") {
      if (resolved(type).kind === "null")
        this.#report(
          typeCode.invalidInteractionPrefill,
          "The prefill of askBoolean must be true or false, not null. Remove 'prefill:' to preselect no button.",
          expression.span,
        );
      else if (!isAssignable(BOOLEAN_TYPE, value))
        this.#report(
          typeCode.invalidInteractionPrefill,
          `The prefill of askBoolean must be true or false${holds}.`,
          expression.span,
        );
      return;
    }
    if (kind === "date" || kind === "time" || kind === "datetime") {
      // A date or time field shows its prefill as ISO text; text is converted first (V30 §20, §35).
      const expected = interactionResultType(kind);
      if (!isAssignable(expected, value))
        this.#report(
          typeCode.invalidInteractionPrefill,
          `The prefill of ${TEMPORAL_ASKS[kind]} must be ${describeValue(expected)}${holds}.${
            resolved(type).kind === "null"
              ? EMPTY_FIELD_FIX
              : isScalar(type, "string")
                ? ` Convert the text with ${TEMPORAL_CONVERSION_NAMES[kind]}(...).`
                : ""
          }`,
          expression.span,
        );
      return;
    }
    const fix =
      resolved(type).kind === "null"
        ? EMPTY_FIELD_FIX
        : kind === "text"
          ? textPrefillFix(expression, name)
          : numberPrefillFix(expression);
    if (kind === "integer") {
      // A non-whole prefill is never rounded; a number variable may be one that widened (rule 1.2).
      if (isScalar(value, "number"))
        this.#report(
          typeCode.invalidInteractionPrefill,
          `The prefill of askInteger must be a whole number (integer)${holds}.${this.#widenedNote(expression)}${ROUND_FIX}.`,
          expression.span,
        );
      else if (!isAssignable(INTEGER_TYPE, value))
        this.#report(
          typeCode.invalidInteractionPrefill,
          `The prefill of askInteger must be a whole number (integer)${holds}.${resolved(type).kind === "null" || isNullable(type) ? fix : " Use a whole number, such as 'prefill: 10'."}`,
          expression.span,
        );
      else if (!Number.isSafeInteger(staticNumber(expression) ?? 0))
        this.#report(
          typeCode.invalidInteractionPrefill,
          `The prefill of askInteger must be a whole number from ${-Number.MAX_SAFE_INTEGER} through ${Number.MAX_SAFE_INTEGER}. Use a smaller number, or remove 'prefill:'.`,
          expression.span,
        );
      return;
    }
    if (kind === "number") {
      if (!isAssignable(NUMBER_TYPE, value))
        this.#report(
          typeCode.invalidInteractionPrefill,
          `The prefill of askNumber must be a number${holds}.${fix}`,
          expression.span,
        );
      return;
    }
    if (!isAssignable(STRING_TYPE, value) || isArithmetic(expression)) {
      this.#report(
        typeCode.invalidInteractionPrefill,
        `The prefill of askText must be text${holds}.${fix}`,
        expression.span,
      );
      return;
    }
    const text = staticVisibleText(expression);
    if (text !== undefined && isBlankTextAnswer(text))
      this.#report(
        typeCode.invalidInteractionPrefill,
        `The prefill of askText must contain a non-whitespace character.${EMPTY_FIELD_FIX}`,
        expression.span,
      );
  }

  // Commands ---------------------------------------------------------------------------------------------------------

  /** A time in a command that expects one: a duration; with a unit after it, a number. */
  *#timeTask(
    expression: Expression,
    command: "wait" | "media",
    unit: DurationUnit | null,
    scope: Scope,
  ): CompileTask<StaticType> {
    if (command === "wait") this.#timeOperands.set(expression, "wait");
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    this.#reportTime(expression, type, command, unit, false);
    return type;
  }

  /**
   * A time is an exact duration; a number never counts as seconds (ADR 0026 §8). A wait or timer keeps the exact unit
   * after its duration apart, which then is a number, or a range of whole units.
   */
  #reportTime(
    expression: Expression,
    type: StaticType,
    command: "wait" | "timer" | "named timer" | "media",
    unit: DurationUnit | null,
    repeat: boolean,
  ): void {
    const isRange = (member: StaticType): boolean =>
      command !== "media" && resolved(member).kind === "range";
    const delay = command === "wait" ? "wait" : "timer";
    if (unit !== null) {
      this.#reportUnless(
        type,
        (member) => isNumeric(member) || isRange(member),
        expression,
        UNIT_AMOUNT_RULE,
        () =>
          unitAmountFix(unit, isScalar(nonNullTypeForUse(type), "duration", "calendarDuration")),
      );
      if (command === "media") return;
      // A range counts whole units, as `for` counts whole numbers. Every draw is at least its start.
      const range = unwrap(expression);
      if (range.kind === "rangeExpression") {
        const start = this.#known(range.start);
        if (
          !this.#checkDrawnRange(expression, `A ${delay}`, { command: delay, repeat, unit }) &&
          typeof start === "number" &&
          !reachesSceneTime(start * DURATION_UNIT_MILLISECONDS[unit])
        )
          this.#report(typeCode.invalidRepeatCount, sceneTimeMessage(delay), range.span);
        return;
      }
      const known = this.#known(expression);
      if (typeof known === "number")
        this.#checkDelayLength(
          expression,
          delay,
          repeat,
          known * DURATION_UNIT_MILLISECONDS[unit],
          describeShownValue(known),
        );
      return;
    }
    const range = resolved(nonNullTypeForUse(type)).kind === "range";
    this.#reportNonDuration(
      expression,
      type,
      command === "media"
        ? "A media position is a duration"
        : `A ${command === "wait" ? "wait" : "timer"} takes a duration`,
      "30 s",
      () => timeUnitFix(expression, command, range),
      command === "media" ? typeCode.invalidMedia : typeCode.invalidOperand,
    );
    const known = this.#knownLength(expression);
    if (command !== "media" && known !== undefined)
      this.#checkDelayLength(expression, delay, repeat, known.milliseconds, formatDuration(known));
  }

  /**
   * A known wait or timer length, as the runtime checks it before it waits: not below zero, not zero for a round of a
   * repeating timer, and short enough for scene time to reach.
   */
  #checkDelayLength(
    expression: Expression,
    command: "wait" | "timer",
    repeat: boolean,
    milliseconds: number,
    shown: string,
  ): void {
    const problem = !isDelayLength(milliseconds)
      ? negativeDelayMessage(command, shown)
      : repeat && !isRoundLength(milliseconds)
        ? zeroRoundMessage(shown)
        : !reachesSceneTime(milliseconds)
          ? sceneTimeMessage(command)
          : undefined;
    if (problem !== undefined) this.#report(typeCode.invalidRepeatCount, problem, expression.span);
  }

  /** The exact duration `expression` is known to have; a calendar duration has no fixed length. */
  #knownLength(expression: Expression): AnyDuration | undefined {
    const known = this.#known(expression);
    return isStaticDuration(known) && !isCalendar(known) ? known : undefined;
  }

  /**
   * Reports a known value that is not a duration where a time is expected. A number, or a range, gets the fix that gives
   * it a unit, and any other value the `example` of a duration.
   */
  #reportNonDuration(
    expression: Expression,
    type: StaticType,
    rule: string,
    example: string,
    fix: () => string,
    code: TypeErrorCode = typeCode.invalidOperand,
  ): void {
    const value = nonNullTypeForUse(type);
    const unitless = isNumeric(value) || resolved(value).kind === "range";
    this.#reportUnless(
      type,
      (member) => isScalar(member, "duration"),
      expression,
      rule,
      // A calendar duration gets the reason it has no fixed length instead.
      () =>
        isScalar(value, "calendarDuration")
          ? ""
          : ` ${unitless ? fix() : `Use a duration such as '${example}'.`}`,
      code,
    );
  }

  *#timerTask(timer: TimerParts, scope: Scope): CompileTask<void> {
    for (const operand of timerOperands(timer)) {
      if (operand === timer.duration) {
        // With a unit, a timer also takes a range of whole units, written directly or held in a variable.
        this.#timeOperands.set(operand, timer.form === "short" ? "timer" : "duration:");
        const duration = yield* compileChild(this.#expressionTask(operand, scope));
        this.#reportTime(
          operand,
          duration,
          timer.form === "short" ? "timer" : "named timer",
          timer.unit,
          timer.repeat,
        );
      } else if (operand === timer.label)
        this.#checkShownText(
          operand,
          yield* compileChild(this.#expressionTask(operand, scope)),
          "a timer label",
        );
      else {
        const type = yield* compileChild(this.#expressionTask(operand, scope));
        this.#reportUnless(
          type,
          (member) => isScalar(member, "string"),
          operand,
          "A timer display is text (string)",
          undefined,
          typeCode.invalidTimerDisplay,
        );
        const text = isScalar(type, "string") ? staticVisibleText(operand) : undefined;
        if (text !== undefined && !isTimerDisplay(text))
          this.#report(
            typeCode.invalidTimerDisplay,
            timerDisplayMessage(shownChoice(text)),
            operand.span,
          );
      }
    }
    if (timer.handler !== null) this.#pendHandler(timer.handler, null, scope);
  }

  /** A block runs later, with the variables visible where it is created. */
  #pendHandler(block: Block, selfHandle: string | null, scope: Scope): void {
    this.#handlers.push({
      block,
      selfHandle,
      scope: scope.visibleAbove(this.#outer),
      outer: this.#outer,
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
    this.#pendHandler(button.handler, null, scope);
  }

  *#mediaTask(media: MediaParts, scope: Scope, selfHandle: string | null): CompileTask<StaticType> {
    const command = media.media === "audio" ? "playAudio" : "playVideo";
    // Media first waits for the previous message's pacing, and later for loading; handlers may run at both.
    this.#suspend();
    for (const operand of mediaOperands(media)) {
      if (operand === media.file) yield* compileChild(this.#fileTask(operand, scope, command));
      else if (operand === media.volume) {
        const type = yield* compileChild(
          this.#requireTask(operand, scope, isNumeric, MEDIA_VOLUME_RULE, typeCode.invalidMedia),
        );
        const known = isNumeric(type) ? this.#known(operand) : undefined;
        if (typeof known === "number" && !isMediaVolume(known))
          this.#report(
            typeCode.invalidMedia,
            mediaVolumeMessage(describeShownValue(known)),
            operand.span,
          );
      } else if (media.repeat?.kind === "times" && operand === media.repeat.count) {
        const type = yield* compileChild(
          this.#requireTask(
            operand,
            scope,
            (member) => isScalar(member, "integer"),
            MEDIA_REPEAT_COUNT_RULE,
            typeCode.invalidMedia,
          ),
        );
        const known = isScalar(type, "integer") ? this.#known(operand) : undefined;
        if (typeof known === "number" && !isMediaRepeatCount(known))
          this.#report(
            typeCode.invalidMedia,
            `${MEDIA_REPEAT_COUNT_RULE}, but this is ${describeShownValue(known)}.`,
            operand.span,
          );
      } else if (media.repeat?.kind === "value" && operand === media.repeat.value) {
        const type = yield* compileChild(this.#expressionTask(operand, scope));
        this.#reportUnless(
          type,
          (member) => isScalar(member, "boolean", "duration"),
          operand,
          MEDIA_REPEAT_RULE,
          () =>
            isNumeric(nonNullTypeForUse(type))
              ? ` Write a count with 'times', such as 'repeat: ${expressionLabel(operand) ?? "3"} times'.`
              : "",
          typeCode.invalidMedia,
        );
        const known = this.#knownLength(operand);
        if (known !== undefined && !isRepeatBudget(known.milliseconds))
          this.#report(
            typeCode.invalidMedia,
            `${MEDIA_REPEAT_RULE}, but this is ${formatDuration(known)}.`,
            operand.span,
          );
      } else yield* compileChild(this.#timeTask(operand, "media", null, scope));
    }
    // `repeat` before the file, or `repeat: true`.
    const indefinite =
      media.repeat?.kind === "indefinite" ||
      (media.repeat?.kind === "value" && isTrueLiteral(media.repeat.value));
    if (indefinite && !media.async)
      this.#report(typeCode.invalidMedia, blockingRepeatMessage(command), media.repeat!.span);
    if (indefinite && media.handlers?.kind === "cues")
      for (const cue of media.handlers.cues)
        if (cue.kind === "finish")
          this.#report(typeCode.invalidMedia, FINISH_NEVER_RUNS_MESSAGE, cue.keywordSpan);
    this.#checkMediaPositions(media);
    for (const block of mediaHandlerBlocks(media))
      this.#pendHandler(block, media.async ? selfHandle : null, scope);
    this.#suspend();
    return media.async ? { kind: "media" } : UNKNOWN_TYPE;
  }

  /**
   * The media positions of a play command that the compiler knows: `startAt`, `endAt`, and each cue position are at
   * least zero, and `endAt` is later than `startAt`, which is the start of the file when left out (V30 §35). A
   * position it cannot know is checked at runtime (`TSR050`).
   */
  #checkMediaPositions(media: MediaParts): void {
    const position = (expression: Expression, subject: string): AnyDuration | undefined => {
      // A calendar duration is a type error of its own.
      const known = this.#knownLength(expression);
      if (known === undefined || isMediaPosition(known.milliseconds)) return known;
      this.#report(
        typeCode.invalidMedia,
        mediaPositionMessage(subject, formatDuration(known)),
        expression.span,
      );
      return undefined;
    };
    const start = media.startAt === null ? 0 : position(media.startAt, "startAt");
    const end = media.endAt === null ? undefined : position(media.endAt, "endAt");
    if (
      start !== undefined &&
      end !== undefined &&
      !isMediaRange(typeof start === "number" ? start : start.milliseconds, end.milliseconds)
    )
      this.#report(
        typeCode.invalidMedia,
        mediaRangeMessage(formatDuration(end), formatDuration(start)),
        media.endAt!.span,
      );
    if (media.handlers?.kind === "cues")
      for (const cue of media.handlers.cues)
        if (cue.offset !== null) position(cue.offset, `${cue.kind} position`);
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
        fileReferenceRule(command),
        typeCode.invalidMedia,
      ),
    );
  }

  /** The type this check reads for a storage key written as a string literal, if it has one. */
  #storageType(key: string): StorageKeyType | undefined {
    if (this.#guessedReads?.has(key) === false) this.#guessedReads.set(key, false);
    return this.#storage.get(key);
  }

  /** Where a storage key's type, or a type that loads of it read, comes from, for a message that names its line. */
  #storageAt(key: string, from: { readonly at: SourceSpan }): SourceSpan {
    this.#guessedReads?.set(key, true);
    return from.at;
  }

  /**
   * Whether this check read the storage key types that it found, `found`: always, unless it read guessed types and found
   * others for a key it read.
   */
  public readsFound(found: ReadonlyMap<string, StorageKeyType>): boolean {
    return this.#guessedReads === null || sameReadKeys(this.#storage, found, this.#guessedReads);
  }

  /** As {@link readsFound}, but only for what its loads without a declared type of their own read. */
  public loadsReadFound(found: ReadonlyMap<string, StorageKeyType>): boolean {
    return (
      this.#guessedLoads === null || sameDeclaredKeys(this.#storage, found, this.#guessedLoads)
    );
  }

  /**
   * A storage key is text (V30 §25). `load "k" == null` loads the key `"k" == null`, so a load names the grouping that
   * compares the loaded value instead.
   */
  *#storageKeyTask(expression: Expression, scope: Scope, load = false): CompileTask<void> {
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    const text = (member: StaticType): boolean => isScalar(member, "string");
    const all = members(type);
    const failing = all.filter((member) => !text(member));
    // A sign gives a number, a duration, or an angle, never text, also of an operand the compiler cannot know.
    const key = unwrap(expression);
    const signed =
      key.kind === "unaryExpression" &&
      key.operator !== "not" &&
      !isKnown(nonNullTypeForUse(this.#typeOf(key.operand)));
    if (!signed && (!isKnown(nonNullTypeForUse(type)) || failing.length === 0)) return;
    if (!signed && failing.length < all.length)
      this.#reportMayBe(
        expression,
        failing.find((member) => member.kind !== "null") ?? failing[0]!,
        all.filter(text),
        typeCode.invalidStorageKey,
      );
    else
      this.#report(
        typeCode.invalidStorageKey,
        load ? LOAD_KEY_MESSAGE : STORAGE_KEY_MESSAGE,
        expression.span,
      );
  }

  /**
   * A saved value under a storage key written as a string literal (ADR 0021 §6): it must fit the type that every load
   * of the key reads, as the previous check found it. A key that no load reads is not checked.
   */
  *#savedValueTask(
    keyExpression: Expression,
    expression: Expression,
    value: StaticType,
  ): CompileTask<void> {
    const key = staticText(keyExpression);
    const kept = key === undefined ? undefined : this.#storageType(key);
    // Saving null removes the key.
    const stored = nonNullType(value);
    if (kept === undefined || stored.kind === "never") return;
    yield* compileChild(
      this.#storeTask(
        storagePlace(key!, kept, this.#text, () => this.#storageAt(key!, kept)),
        expression,
        stored,
        false,
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
    code: TypeErrorCode = typeCode.invalidOperand,
  ): CompileTask<StaticType> {
    const type = yield* compileChild(this.#expressionTask(expression, scope));
    this.#reportUnless(type, accepts, expression, rule, undefined, code);
    return type;
  }

  /**
   * What a store checks at compile time: for a load, its default, unless that default cannot be saved and was reported
   * already. The loaded value itself is checked at runtime against the load's type, which is then the type of the
   * receiving variable or the default's. A load of the type another load of its key declares is checked as the loaded
   * value instead: that type may take values that its default, which it accepts, does not, such as text where the
   * default is a number.
   */
  #checkedValue(expression: Expression): Expression {
    const value = unwrap(expression);
    return value.kind === "loadExpression" &&
      value.defaultValue !== null &&
      !this.#rejectedDefaults.has(value) &&
      !this.#declaredLoads.has(value)
      ? value.defaultValue
      : expression;
  }

  /**
   * After a store checked a load's default, stores the loaded value of type `loaded` in a place of type `place`: its
   * objects, which may have other properties, and what it decides where the default decided nothing, such as after
   * `default: null`. A load of a computed key gives a value of unknown type, which the place may then hold (#859).
   */
  #storeLoaded(place: StaticType, loaded: StaticType, expression: Expression): void {
    settle(place, loaded, expression.span);
  }

  /**
   * For `x = x otherwise d`, which keeps `x` where it is not null and stores `d` where it is, as
   * `if x == null { x = d }` does (#859), what it stores: `d` and its type, or for a chain, the chain after `x` and the
   * type it gives. `undefined` for any other value, and where `x` is never null, so its fallback never runs.
   */
  #ownFallback(
    expression: Expression,
    variable: Variable,
    scope: Scope,
  ): { readonly expression: Expression; readonly type: StaticType } | undefined {
    const chain: Extract<Expression, { kind: "binaryExpression" }>[] = [];
    let value = unwrap(expression);
    while (value.kind === "binaryExpression" && value.operator === "otherwise") {
      chain.push(value);
      value = unwrap(value.left);
    }
    const read = unwrap(value);
    const entry = read.kind === "identifier" ? scope.resolve(read.name) : undefined;
    if (
      chain.length === 0 ||
      entry?.kind !== "variable" ||
      entry.variable !== variable ||
      neverNull(this.#typeOf(value))
    )
      return undefined;
    chain.reverse();
    let type = plainType(this.#typeOf(chain[0]!.right));
    for (const node of chain.slice(1)) {
      const replaced: OpenType[] = [];
      type = fallbackType(
        type,
        plainType(this.#typeOf(node.right)),
        this.#kept.has(node),
        replaced,
      );
      if (replaced.length > 0) this.#replaced.push({ node, slots: replaced });
    }
    return { expression: chain.length === 1 ? chain[0]!.right : expression, type };
  }

  /**
   * Records a runtime check where a value whose type has unknown parts is stored in a place (ADR 0021 rule 1.7), also
   * an object of type `object`, whose properties are unknown (V30 §13). The place's type is read after the whole
   * check, because a later value can still decide it.
   */
  #recordRuntimeCheck(
    site: RuntimeCheckSite,
    place: StaticType,
    label: string,
    value: StaticType,
  ): void {
    if (mayBeUnknown(value)) this.#runtimeChecks.push({ site, place, label });
    else if (containsType(value, (part) => part.kind === "object" && part.properties === null))
      this.#runtimeChecks.push({ site, place, label, properties: true });
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
    code: TypeErrorCode = typeCode.invalidOperand,
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
        code,
      );
      return;
    }
    // Where a duration is wanted, a calendar duration needs the reason it does not fit (ADR 0026).
    const reason =
      isScalar(value, "calendarDuration") && accepts(DURATION_TYPE)
        ? " A calendar day or month has no fixed length. Use a fixed length such as '1 day' or '24 h'."
        : "";
    this.#report(
      code,
      `${rule}, but this is ${describeValue(value)}.${reason}${fix()}`,
      expression.span,
    );
  }

  /**
   * Notes a value that is changed in place, with the values it is part of as written, such as `p` in `p.toys.add(1)`.
   * As for narrowing (see `rootName`), a step that gives a copy, such as a dict's `values`, counts too: leaving out a
   * fallback is never wrong, while naming one where a change reaches the value would lose that change.
   */
  #noteChanged(expression: Expression): void {
    for (let node = expression; ;) {
      this.#changed.add(node);
      if (node.kind === "parenthesizedExpression") node = node.expression;
      else if (node.kind === "propertyAccessExpression" || node.kind === "indexExpression")
        node = node.object;
      else return;
    }
  }

  /**
   * Reports a change of `changed` that lands in a value no variable holds, such as `obj()` in `obj().n = 5`, so the
   * change is lost with it (owner decision O3, 2026-10-16). `start` is the value changed: the object of an assigned
   * property or element, or the receiver of an in-place method. Of it and the values it is part of, the first that may
   * be a speaker or a handle takes the change, as every copy of it names the same one; so does a variable. A list, set,
   * dict, or object that a property computes when it is read, such as a dict's `values`, is a copy no variable holds as
   * well: the nearest such property is reported unless the value it is read from is itself such a copy. A value the
   * compiler cannot know may be a speaker, so it is not reported, nor is a value that can only be null, which has
   * nothing to change and its own message.
   */
  #reportChangedCopy(changed: Expression, start: Expression): void {
    let computed: Extract<Expression, { kind: "propertyAccessExpression" }> | undefined;
    for (let node = start; ;) {
      const type = this.#typeOf(node);
      const reference = members(type).some(
        (member) => !isKnown(member) || HANDLE_KINDS.has(resolved(member).kind),
      );
      if (nonNullType(type).kind === "never") return;
      if (reference) break;
      if (node.kind === "parenthesizedExpression") node = node.expression;
      else if (node.kind === "propertyAccessExpression" || node.kind === "indexExpression") {
        if (node.kind === "propertyAccessExpression" && this.#computedCopy(node, type))
          computed ??= node;
        node = node.object;
      } else {
        if (node.kind !== "identifier") {
          this.#report(typeCode.changedCopy, changedCopyMessage(changed, node), changed.span);
          return;
        }
        break;
      }
    }
    if (computed === undefined) return;
    const owner = resolved(members(nonNullType(this.#typeOf(computed.object)))[0]!).kind;
    this.#report(typeCode.changedCopy, computedCopyMessage(computed, owner), changed.span);
  }

  /**
   * Whether `read`, of type `type`, is a list, set, dict, or object that its property computes when it is read, such as
   * a dict's `values` or a set's `first`, rather than a part its object keeps, so that a change of it changes a copy.
   */
  #computedCopy(
    read: Extract<Expression, { kind: "propertyAccessExpression" }>,
    type: StaticType,
  ): boolean {
    const changeable = members(type).some((member) => {
      const value = resolved(member);
      return isCollection(value) || value.kind === "object";
    });
    return (
      changeable &&
      members(nonNullType(this.#typeOf(read.object))).every((owner) => {
        const value = memberPropertyType(owner, read.property.name);
        return value !== undefined && value.kind !== "placeRead";
      })
    );
  }

  /** Reports an in-place change in statement position, such as `things().sort()`, of a value no variable holds. */
  #reportCopyChangedInPlace(expression: Expression): void {
    if (expression.kind !== "callExpression") return;
    const callee = unwrap(expression.callee);
    if (callee.kind !== "propertyAccessExpression") return;
    const method = callee.property.name;
    if (!COLLECTION_CHANGES.has(method) && !LIST_REORDERS.has(method)) return;
    // Only a list, set, or dict that has the method changes: text `reverse` gives a new text, and a method that a value
    // does not have is reported as such.
    const changes = members(this.#typeOf(callee.object)).some(
      (member) => isCollection(resolved(member)) && memberMethodType(member, method) !== undefined,
    );
    if (changes) this.#reportChangedCopy(callee.object, callee.object);
  }

  /** A value that may be of a member type the operation does not support: name the test that makes it safe. */
  #reportMayBe(
    expression: Expression,
    failing: StaticType,
    passing: readonly StaticType[],
    code: TypeErrorCode = typeCode.invalidOperand,
  ): void {
    this.#report(
      code,
      mayBeMessage(expression, failing, passing, !this.#changed.has(expression)),
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
      const property = misfitProperty(first, other);
      // A property type has no written form, so objects that disagree need one type for that property.
      const fix =
        property !== undefined
          ? `give '${property.name}' one type in every element`
          : (unnamedMixFix(mixed) ?? keepBothFix(this.#declaredBy.get(literal) ?? null, written));
      this.#report(
        typeCode.mixedTypes,
        `This ${kind} mixes ${mixDescription(first, other)}. A ${kind} holds one type. ${capitalize(fix)}.`,
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

  #report(code: TypeErrorCode, message: string, span: SourceSpan): void {
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

  /** Forgets what is known about the variables where `test` holds. */
  forget(test: (variable: Variable, type: StaticType) => boolean): void {
    for (const fact of allFacts(this.#facts))
      if (test(fact.variable, fact.type)) this.set(fact.variable, undefined);
  }

  /** Forgets what is known about variables that other code may change, where `test` holds. */
  forgetShared(test: (variable: Variable, type: StaticType) => boolean): void {
    for (const fact of allFacts(this.#shared))
      if (test(fact.variable, fact.type)) this.set(fact.variable, undefined);
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

/**
 * Whether a change of the kind `how` may undo what is known about a variable: its narrowed `type`. An assignment may
 * undo anything. A change in place keeps the variable on the same list, set, dict, or object, so it is never null after
 * it, but it may change which type that value has: an empty list that both `integer[]` and `string[]` hold may take a
 * text, and a list that `xs is integer[]` found among the lists of a `list` may too. So only a declared member itself,
 * the only one of its kind, stays known.
 */
function undoneBy(variable: Variable, type: StaticType, how: Sharing | false): boolean {
  if (how !== "changes") return how === "assigns";
  const declared = members(variable.type).map(resolved);
  if (declared.some((member) => member.kind === "unknown" || member.kind === "open")) return true;
  return members(type).some((member) => {
    const value = resolved(member);
    if (
      value.kind !== "list" &&
      value.kind !== "set" &&
      value.kind !== "dict" &&
      value.kind !== "object"
    )
      return false;
    const sameKind = declared.filter((other) => other.kind === value.kind);
    return sameKind.length !== 1 || sameKind[0] !== value;
  });
}

/**
 * What one iteration of a loop may do before the next test: the variables it assigns or changes in place, and whether it
 * may suspend.
 */
interface LoopEffects {
  readonly writes: ReadonlyMap<string, Sharing>;
  readonly suspends: boolean;
}

const SUSPENDING_STATEMENTS: ReadonlySet<Statement["kind"]> = new Set([
  "sayStatement",
  "showButtonStatement",
  "showPopupStatement",
  "openUrlStatement",
  "exportTextStatement",
  "waitStatement",
  "timerStatement",
  "playMediaStatement",
  "showImageStatement",
  "hideImageStatement",
  "showCameraStatement",
  "hideCameraStatement",
  "stopAudioStatement",
  "saveStatement",
  "deleteStatement",
  // Blocks of the caller keep running while a called file runs.
  "callFileStatement",
]);

/** What a program's loops and functions may change (ADR 0021 rule 5.5). */
interface ProgramEffects {
  /** Names that function bodies and timer or media blocks assign or change in place. */
  readonly shared: ReadonlyMap<string, Sharing>;
  /** Names that the file's top level assigns or changes, which another file's `call` may run (ADR 0022 §5). */
  readonly rootAssigned: ReadonlyMap<string, Sharing>;
  /** Whether the file calls a file, so another file's top level may run during the call. */
  readonly callsFiles: boolean;
  /** Whether the file enters `main.tease` again at its top, after the start values have run. */
  readonly entersMain: boolean;
  /** The effects of each loop, by its body; a `while` loop includes its condition. */
  readonly loops: ReadonlyMap<Block, LoopEffects>;
}

/**
 * The code that a check found never runs: the statements of a branch or loop body that no value takes or after a
 * statement that never continues, and by place the `and`, `or`, and `otherwise` whose right side never runs.
 */
interface DeadCode {
  readonly statements: ReadonlySet<Statement>;
  readonly operands: ReadonlySet<string>;
}

/** Whether `found` holds all of `dead`. */
function coversDeadCode(found: DeadCode, dead: DeadCode): boolean {
  for (const statement of dead.statements) if (!found.statements.has(statement)) return false;
  for (const place of dead.operands) if (!found.operands.has(place)) return false;
  return true;
}

/** What the code of a project may change, as the check uses it. */
interface ProjectEffects {
  readonly files: readonly ProgramEffects[];
  readonly loops: ReadonlyMap<Block, LoopEffects>;
  /** The globals that a function or a timer or media block of any file assigns or changes in place, with how. */
  readonly sharedGlobals: ReadonlyMap<string, Sharing>;
}

/** What the code of each file may change, leaving out the code that never runs. */
function projectEffects(programs: readonly Program[], dead: DeadCode): ProjectEffects {
  const files = programs.map((program, file) => programEffects(program, file, dead));
  const sharedGlobals = new Map<string, Sharing>();
  for (const fileEffects of files)
    for (const [name, how] of fileEffects.shared) noteSharing(sharedGlobals, name, how);
  // While a `call` runs, any file's top level may run and assign globals (ADR 0022 §5, §6).
  if (files.some((fileEffects) => fileEffects.callsFiles))
    for (const fileEffects of files)
      for (const [name, how] of fileEffects.rootAssigned) noteSharing(sharedGlobals, name, how);
  return {
    files,
    loops: new Map(files.flatMap((fileEffects) => [...fileEffects.loops])),
    sharedGlobals,
  };
}

/** Whether two sets of effects give a check the same facts. */
function sameProjectEffects(left: ProjectEffects, right: ProjectEffects): boolean {
  const sameSharing = (
    one: ReadonlyMap<string, Sharing>,
    other: ReadonlyMap<string, Sharing>,
  ): boolean => one.size === other.size && [...one].every(([name, how]) => other.get(name) === how);
  return (
    sameSharing(left.sharedGlobals, right.sharedGlobals) &&
    left.files.every(
      (fileEffects, file) =>
        fileEffects.entersMain === right.files[file]!.entersMain &&
        sameSharing(fileEffects.shared, right.files[file]!.shared),
    ) &&
    [...left.loops].every(([body, loop]) => {
      const other = right.loops.get(body);
      return (
        other !== undefined &&
        loop.suspends === other.suspends &&
        sameSharing(loop.writes, other.writes)
      );
    })
  );
}

interface LoopNode {
  readonly body: Block;
  readonly parent: LoopNode | null;
  readonly writes: Map<string, Sharing>;
  suspends: boolean;
}

/** A node to walk, with the innermost loop around it, whether it stands in a function or block, and whether it runs. */
type EffectWork = {
  readonly loop: LoopNode | null;
  readonly inside: boolean;
  readonly runs: boolean;
} & ({ readonly statement: Statement } | { readonly expression: Expression });

/**
 * Collects in one pass the names that functions and blocks assign, and the effects of every loop. A loop's effects
 * include those of the loops inside it, but not those of timer or media blocks it starts, which run later. Code that
 * `dead` holds never runs, so it changes nothing; a loop in it has effects of its own, for the check of its body.
 */
function programEffects(program: Program, file: number, dead: DeadCode): ProgramEffects {
  const shared = new Map<string, Sharing>();
  const rootAssigned = new Map<string, Sharing>();
  let callsFiles = false;
  let entersMain = false;
  const nodes: LoopNode[] = [];
  const work: EffectWork[] = [];
  const enter = (
    statements: readonly Statement[],
    loop: LoopNode | null,
    inside: boolean,
    runs: boolean,
  ): void => {
    for (let index = statements.length - 1; index >= 0; index -= 1)
      work.push({ statement: statements[index]!, loop, inside, runs });
  };
  const loopNode = (body: Block, parent: LoopNode | null): LoopNode => {
    const node: LoopNode = { body, parent, writes: new Map(), suspends: false };
    nodes.push(node);
    return node;
  };
  enter(program.statements, null, false, true);
  while (work.length > 0) {
    const item = work.pop()!;
    // Code that never runs is part of no loop around it.
    const runs = item.runs && !("statement" in item && dead.statements.has(item.statement));
    const loop = runs === item.runs ? item.loop : null;
    const { inside } = item;
    const write = (name: string, how: Sharing): void => {
      if (runs) noteSharing(inside ? shared : rootAssigned, name, how);
      if (loop !== null) noteSharing(loop.writes, name, how);
    };
    const handlers = (node: Statement | Expression): void => {
      for (const block of handlerBlocks(node)) enter(block.statements, null, true, runs);
    };
    if ("expression" in item) {
      const expression = item.expression;
      if (
        loop !== null &&
        (expression.kind === "interactionExpression" ||
          expression.kind === "sayExpression" ||
          expression.kind === "showButtonExpression" ||
          expression.kind === "showPopupExpression" ||
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
        if (root !== null) write(root, "changes");
      }
      handlers(expression);
      // The right side of an `and`, `or`, or `otherwise` that never runs changes nothing.
      const skipped =
        expression.kind === "binaryExpression" &&
        (expression.operator === "and" ||
          expression.operator === "or" ||
          expression.operator === "otherwise") &&
        dead.operands.has(placeKey(file, expression.span))
          ? expression.right
          : null;
      for (const part of expressionParts(expression))
        work.push(
          part === skipped
            ? { expression: part, loop: null, inside, runs: false }
            : { expression: part, loop, inside, runs },
        );
      continue;
    }
    const statement = item.statement;
    if (loop !== null && SUSPENDING_STATEMENTS.has(statement.kind)) loop.suspends = true;
    if (runs && statement.kind === "callFileStatement") callsFiles = true;
    if (
      runs &&
      (statement.kind === "gotoStatement" ||
        statement.kind === "callFileStatement" ||
        statement.kind === "fallbackStatement") &&
      statement.target !== null &&
      entersMainAtTop(statement.target)
    )
      entersMain = true;
    // The `default:` form of a global assigns it where the declaration runs.
    if (runs && statement.kind === "globalStatement" && statement.assignment !== null)
      noteSharing(inside ? shared : rootAssigned, statement.name.name, "assigns");
    if (statement.kind === "assignmentStatement") {
      // A store into an element or property changes the variable that holds it in place, too.
      const root = rootName(statement.target);
      if (root !== null)
        write(root, statement.target.kind === "identifier" ? "assigns" : "changes");
      // A timer or media property write may run a block at once.
      if (statement.target.kind !== "identifier" && loop !== null) loop.suspends = true;
    }
    handlers(statement);
    switch (statement.kind) {
      case "functionDeclaration":
        enter(statement.body.statements, null, true, runs);
        // A parameter default runs in the function too, and the blocks it shows run later.
        for (const parameter of statement.parameters)
          if (parameter.defaultValue !== null)
            work.push({ expression: parameter.defaultValue, loop: null, inside: true, runs });
        continue;
      case "whileStatement": {
        const node = loopNode(statement.body, loop);
        enter(statement.body.statements, node, inside, runs);
        work.push({ expression: statement.condition, loop: node, inside, runs });
        continue;
      }
      case "repeatStatement":
      case "forStatement":
        enter(statement.body.statements, loopNode(statement.body, loop), inside, runs);
        break;
      default:
        enter(nestedStatements(statement), loop, inside, runs);
    }
    for (const expression of statementExpressions(statement))
      work.push({ expression, loop, inside, runs });
  }
  // Inner loops come after the loops around them, so walking backwards adds each loop's effects to its parent.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (node.parent === null) continue;
    for (const [name, how] of node.writes) noteSharing(node.parent.writes, name, how);
    node.parent.suspends ||= node.suspends;
  }
  return {
    shared,
    rootAssigned,
    callsFiles,
    entersMain,
    loops: new Map(
      nodes.map((node) => [node.body, { writes: node.writes, suspends: node.suspends }]),
    ),
  };
}

/** Methods that change the list or set they are called on. */
/** The value kinds an operand of unknown type might be, to tell whether a known operand could combine with any. */
/** Whether a value of type `result` may fit a place of type `type` when the script runs, where a number may be whole. */
function mayFit(type: StaticType, result: StaticType): boolean {
  return (
    isAssignable(type, result) ||
    (isScalar(result, "number") &&
      members(resolved(type)).some((member) => isScalar(member, "integer")))
  );
}

const OPERAND_KINDS: readonly StaticType[] = [
  INTEGER_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  BOOLEAN_TYPE,
  DURATION_TYPE,
  CALENDAR_DURATION_TYPE,
  ANGLE_TYPE,
  DATE_TYPE,
  TIME_TYPE,
  DATETIME_TYPE,
  ABSOLUTE_DATE_TIME_TYPE,
  { kind: "list", element: UNKNOWN_TYPE },
];

/** Whether a variable of this type holds a list, set, or dict whose element type no value decided yet. */
function hasUndecidedElements(type: StaticType): boolean {
  return members(nonNullType(type)).some((member) => {
    const value = resolved(member);
    return isCollection(value) && resolved(value.element).kind === "open";
  });
}

/**
 * Whether no value decided the element type of a list or the value type of a dict receiver yet, as for `[]`, `dict{}`,
 * or `dict{ a: null }`, so that a first value decides it.
 */
function undecidedValues(type: StaticType): boolean {
  const shared = elementStoreType(type);
  const parts = shared === undefined ? [] : members(shared).map(resolved);
  return (
    parts.some((part) => part.kind === "open") &&
    parts.every((part) => part.kind === "open" || part.kind === "null")
  );
}

/** The methods of a dict. */
const DICT_METHODS: ReadonlySet<string> = new Set(["contains", "remove", "clear", "get"]);

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

/**
 * The type of a loop variable that takes each value of a collection whose values are of type `element`, as a `let` of a
 * read of one would have: a copy that keeps the plain type (see {@link ownNull}), or the unknown type of a place that held
 * only values the compiler cannot know (see {@link readsHeldUnknown}). Either way the loop reads the values, so a store
 * that decides them later in the check decides them for the loop too.
 */
function loopValueType(element: StaticType): StaticType {
  if (!readsHeldUnknown(element)) return ownNull(copyType(plainType(element)));
  observe(element);
  return UNKNOWN_TYPE;
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
  return (
    callee.kind === "identifier" &&
    PURE_BUILTINS.has(callee.name) &&
    !isFileStoreCall(expression) &&
    !isLockCall(expression)
  );
}

// Places -------------------------------------------------------------------------------------------------------------

/** The values that exist only in the current session, as a diagnostic names them. */
const SESSION_VALUES =
  "Speakers, camera views, permanent buttons, and timer, media, or message handles";

/** Whether a value of this type is or holds one that exists only in the current session and cannot be saved. */
function holdsSessionValue(type: StaticType): boolean {
  return containsType(type, (part) =>
    ["speaker", "timer", "media", "camera", "permanentButton", "messageHandle"].includes(part.kind),
  );
}

/**
 * A storage key as the place that a saved value must fit: the type every load of the key reads (ADR 0021 §6). Its
 * subject names the line of the load that gives the type, from `at`.
 */
function storagePlace(
  key: string,
  kept: StorageKeyType,
  text: PlaceText,
  at: () => SourceSpan,
): Place {
  const type = detachedType(kept.type);
  return {
    type,
    label: null,
    get subject() {
      return `${storageLabel(key)} is ${kept.declared ? "declared" : "loaded"} as ${describeValue(type)} on ${text.line(at())}`;
    },
    verb: "save",
    fix: (value) => {
      const both = union([type, value]);
      return isAnnotatable(both)
        ? ` To allow it, declare a type that includes it, as in 'let value: ${typeName(both)} = load(...)'.`
        : "";
    },
  };
}

/** How a message names a storage key, as in `Storage key "level"`. */
function storageLabel(key: string): string {
  return `Storage key ${JSON.stringify(key)}`;
}

function variablePlace(variable: Variable, text: PlaceText): Place {
  const name = variable.name;
  const type = variable.type;
  const declared = variableDeclared(variable, text.keyword(name));
  return {
    type,
    widening:
      variable.declaration === undefined ? undefined : { root: variable.declaration, path: [] },
    inferred: variable.declaration === undefined ? undefined : "variable",
    label: name,
    declared,
    get subject() {
      return `'${name}' holds ${describeValue(type)}${decidedAt(type, text.line)}`;
    },
    verb: "be set to",
    fix: (rejected, expression) => typeFix(declared, type, rejected, expression),
  };
}

/**
 * Where a fix writes another type for a variable: its `let` or `global`, or its parameter. A loop variable has no
 * declaration to change, nor has a name the session gives, such as a media block's own handle.
 */
function variableDeclared(variable: Variable, keyword: "global" | "let"): Declared {
  if (variable.parameter !== undefined) return { kind: "parameter", parameter: variable.parameter };
  const kind = variable.declaration?.kind;
  const declared =
    kind === undefined
      ? variable.annotated === true
      : kind !== "forStatement" && kind !== "identifier";
  return declared ? { kind: keyword, name: variable.name } : null;
}

/** The elements of a collection that `name` spells, whose type a fix writes where `declared` says. */
function elementPlace(
  collection: CollectionType,
  name: string | null,
  declared: Declared,
  nullable: boolean,
  text: PlaceText,
  inferred = false,
  owner?: PlacePath,
  verb = "contain",
  listed = false,
): Place {
  const holder = name === null ? `This ${collection.kind}` : `'${name}'`;
  return {
    type: collection.element,
    widening: extendPath(owner, "[]"),
    inferred: inferred ? "part" : undefined,
    label: null,
    elementOf: name,
    get subject() {
      const element = resolved(collection.element);
      return element.kind === "open"
        ? `${holder} holds a ${collection.kind}`
        : `${holder} holds ${typeName(element).replaceAll(" | ", " or ")} values (${typeName(collection)})${decidedAt(collection.element, text.line)}`;
    },
    verb,
    listed,
    fix: (value) => elementFix(declared, collection, value, nullable),
  };
}

/** The place of a property inside a stored object literal, named after the place that keeps the object. */
function nestedPropertyPlace(type: StaticType, owner: Place, name: string, text: PlaceText): Place {
  const widening = extendPath(owner.widening, name);
  if (owner.label !== null) {
    const label = `${owner.label}.${name}`;
    const declared: Declared = owner.declared ? { kind: "property", label } : null;
    return propertyPlace(type, label, `'${label}'`, text, widening, declared);
  }
  const subject =
    owner.elementOf === undefined || owner.elementOf === null
      ? `Property '${name}'`
      : `Property '${name}' of the elements of '${owner.elementOf}'`;
  return propertyPlace(type, null, subject, text, widening, null);
}

function propertyPlace(
  type: StaticType,
  label: string | null,
  name: string,
  text: PlaceText,
  widening: PlacePath | undefined,
  declared: Declared,
): Place {
  return {
    type,
    widening,
    // No type can be written for a property.
    inferred: "part",
    label,
    declared,
    get subject() {
      return `${name} holds ${describeValue(type)}${decidedAt(type, text.line)}`;
    },
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

/**
 * The value type of a timer, media, message, or camera view handle property, or `undefined` when it cannot be read or
 * assigned.
 */
function handlePropertyType(
  handle: HandleKind,
  name: string,
  use: "read" | "assign",
): StaticType | undefined {
  if (handle === "camera") return name === "placement" ? STRING_TYPE : undefined;
  if (handle === "messageHandle") return name === "text" ? STRING_TYPE : undefined;
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

/**
 * What a property read gives on one known member type, or `undefined` when that type has no such property: a place read
 * for a property or an element that the value keeps, which a change through it reaches, and the type of a new value for
 * a property computed when it is read, so that a change through it changes a copy.
 */
function memberPropertyType(type: StaticType, name: string): StaticType | PlaceRead | undefined {
  const value = resolved(type);
  switch (value.kind) {
    case "list":
    case "set":
      if (name === "length") return INTEGER_TYPE;
      if (!LIST_ELEMENT_READS.has(name)) return undefined;
      // A set member is read as a copy (ADR 0014).
      return value.kind === "list" ? placeRead(value.element) : value.element;
    case "dict":
      // `keys` and `values` are new lists, in entry order.
      if (name === "length") return INTEGER_TYPE;
      if (name === "keys") return { kind: "list", element: STRING_TYPE };
      return name === "values" ? { kind: "list", element: copyType(value.element) } : undefined;
    case "object":
      return placeRead(value.properties?.get(name) ?? UNKNOWN_TYPE);
    case "timer":
    case "media":
    case "camera":
    case "messageHandle":
      return handlePropertyType(value.kind, name, "read");
    case "scalar":
      if (isScalar(value, "string")) return name === "length" ? INTEGER_TYPE : undefined;
      // A calendar duration has its components; an exact duration has none (ADR 0026).
      if (value.name === "calendarDuration")
        return name === "days" || name === "months"
          ? INTEGER_TYPE
          : name === "exactOffset"
            ? DURATION_TYPE
            : undefined;
      if (value.name === "duration" || value.name === "angle") return undefined;
      return temporalFieldType(value.name, name);
    case "range":
    case "null":
    case "permanentButton":
      return undefined;
    default:
      // A speaker keeps its properties, and a value of unknown type may.
      return placeRead(UNKNOWN_TYPE);
  }
}

/** The result type of a method call on one known member type, or `undefined` when it has no such method. */
function memberMethodType(type: StaticType, method: string): StaticType | undefined {
  const value = resolved(type);
  if (value.kind === "timer" || value.kind === "media")
    return ["pause", "resume", "stop"].includes(method) ? NULL_TYPE : undefined;
  // A message or a permanent button removes itself (#836).
  if (value.kind === "messageHandle" || value.kind === "permanentButton")
    return method === "remove" ? NULL_TYPE : undefined;
  if (value.kind === "camera") return undefined;
  if (value.kind === "speaker" || value.kind === "unknown" || value.kind === "open")
    return UNKNOWN_TYPE;
  // Text operations (V30 §8).
  if (isScalar(value, "string")) {
    const member = TEXT_MEMBERS.get(method);
    return member?.parameters ? textResultType(member) : undefined;
  }
  if (value.kind === "scalar") return temporalMethodType(value.name, method);
  // A range gives its whole numbers as a new list (V30 §6).
  if (value.kind === "range")
    return method === "toList" ? { kind: "list", element: INTEGER_TYPE } : undefined;
  if (value.kind === "dict") {
    if (method === "contains") return BOOLEAN_TYPE;
    if (method === "clear") return NULL_TYPE;
    // A removed value leaves the dict, and `get` gives a copy, so the type is a copy for the place that keeps it.
    return method === "remove" || method === "get" ? ownNull(copyType(value.element)) : undefined;
  }
  if (value.kind !== "list" && value.kind !== "set") return undefined;
  switch (method) {
    case "join":
      return value.kind === "list" ? STRING_TYPE : undefined;
    // A list reorders in place; a set keeps its insertion order (V30 §16).
    case "sort":
    case "shuffle":
    case "reverse":
      return value.kind === "list" ? NULL_TYPE : undefined;
    // A part of a list is a new list.
    case "take":
    case "takeLast":
      return value.kind === "list" ? { kind: "list", element: copyType(value.element) } : undefined;
    // A set operation builds a new collection of the receiver's kind.
    case "intersection":
    case "union":
    case "difference":
      return { kind: value.kind, element: copyType(value.element) };
    case "contains":
      return BOOLEAN_TYPE;
    // Only a list has positions; a value that no element equals has none (#840).
    case "indexOf":
    case "lastIndexOf":
      return value.kind === "list" ? optional(INTEGER_TYPE) : undefined;
    case "count":
      return value.kind === "list" ? INTEGER_TYPE : undefined;
    // An element is a copy for the place that keeps it; the default joins it where the call is checked (#844).
    case "get":
      return value.kind === "list" ? ownNull(copyType(value.element)) : undefined;
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
      return value.kind === "list" ? ownNull(copyType(value.element)) : undefined;
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
  "absoluteDateTime",
]);

/** Whether a value of this type is a date, time, date and time, or absolute date and time. */
function isTemporal(type: StaticType): boolean {
  const value = resolved(type);
  return value.kind === "scalar" && TEMPORAL_KINDS.has(value.name);
}

/** The type of a read-only field of a date or time value (V30 §35); an absolute date and time has none. */
function temporalFieldType(kind: ScalarTypeName, name: string): StaticType | undefined {
  if (kind === "date" || kind === "datetime") {
    if (["year", "month", "day", "weekNumber", "weekYear"].includes(name)) return INTEGER_TYPE;
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
      return kind === "datetime" || kind === "absoluteDateTime" ? STRING_TYPE : undefined;
    case "toAbsoluteDateTime":
      return kind === "datetime" ? ABSOLUTE_DATE_TIME_TYPE : undefined;
    case "toDateTime":
      return kind === "absoluteDateTime" ? DATETIME_TYPE : undefined;
    case "toSeconds":
    case "toMilliseconds":
      return kind === "absoluteDateTime" ? INTEGER_TYPE : undefined;
    default:
      return undefined;
  }
}

/** Property names whose write on a media handle first waits for the previous message's pacing. */
const MEDIA_PACED_PROPERTIES: ReadonlySet<string> = new Set(["position", "remaining", "volume"]);

/** Whether a value of this type may be of one of the given kinds, such as a handle, including a value of unknown type. */
function mayBe(
  type: StaticType,
  ...kinds: (
    "timer" | "media" | "camera" | "messageHandle" | "permanentButton" | "list" | "speaker"
  )[]
): boolean {
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
  if (
    member.kind === "timer" ||
    member.kind === "media" ||
    member.kind === "camera" ||
    member.kind === "messageHandle"
  ) {
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
      problem: `Property '${name}' of ${describeValue(member)} cannot be assigned. Date and time values do not change.`,
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
        : `Only objects, speakers, and timer, media, and message handles have properties to assign, but this is ${describeValue(member)}.`,
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

const STORAGE_KEY_MESSAGE = "Storage key must be a string.";

const LOAD_KEY_MESSAGE = `${STORAGE_KEY_MESSAGE} To compare the loaded value, write 'load("k", default: null) == null'.`;

/** The name of the variable a declaration declares. */
function declarationName(declaration: Declaration): string {
  if (declaration.kind === "identifier") return declaration.name;
  return declaration.kind === "forStatement" ? declaration.variable.name : declaration.name.name;
}

/** The type of the values of a dict type, of each member's values for a union of dicts; `undefined` for another. */
function dictValueType(type: StaticType): StaticType | undefined {
  const values: StaticType[] = [];
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (value.kind === "dict") values.push(value.element);
    else if (value.kind === "unknown") values.push(UNKNOWN_TYPE);
    else return undefined;
  }
  return values.length === 1 ? values[0] : union(values);
}

/**
 * The fix for a mix whose union type has no written form, because a camera view's or permanent button's type has no
 * name, or `undefined` when the union can be declared.
 */
function unnamedMixFix(mixed: StaticType): string | undefined {
  if (containsType(mixed, (part) => part.kind === "camera"))
    return "a camera view's type cannot be declared, so keep camera views apart from other values";
  if (containsType(mixed, (part) => part.kind === "permanentButton"))
    return "a permanent button's type cannot be declared, so keep permanent buttons apart from other values";
  return undefined;
}

/** Value kinds that `${...}` cannot show. */
const UNSHOWABLE_KINDS: ReadonlySet<StaticType["kind"]> = new Set([
  "list",
  "set",
  "dict",
  "object",
  "range",
  "timer",
  "media",
  "messageHandle",
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

/** A numeric value with `-` before it: the values an `askChoice` restricted it to change sign too. */
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

/** The text, number, true, false, null, exact duration, or angle that an expression certainly is, or `undefined`. */
function literalValue(expression: Expression): ScalarValue | null | undefined {
  const known = staticChoiceValue(expression)?.value;
  // An exact duration is compared by its length and an angle by its size, so in its type each stands for its
  // milliseconds or its degrees. A calendar duration has no fixed length.
  if (known === null || typeof known !== "object") return known;
  if (known.kind === "angle") return known.degrees;
  return isCalendar(known) ? undefined : known.milliseconds;
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
  if (value === null || typeof value !== "object") return [{ value, measure: null }];
  if (value.kind === "angle") return [{ value: value.degrees, measure: "angle" }];
  return isCalendar(value) ? undefined : [{ value: value.milliseconds, measure: "duration" }];
}

/** The ways that a check finds possible, with those an earlier check of the same code found. */
function joinedWays(known: readonly boolean[] | undefined, ways: boolean[]): boolean[] {
  return known === undefined ? ways : ways.map((way, index) => way || known[index] === true);
}

/**
 * Whether the literal values of `taken` include every value that a value of `type` can hold: both booleans, or each
 * button value of an `askChoice` with literal values, and `null` when it may be null.
 */
function takesEveryValue(type: StaticType, taken: readonly PossibleValue[]): boolean {
  const possible: PossibleValue[] = [];
  for (const member of members(type)) {
    const value = resolved(member);
    if (value.kind === "scalar" && value.name === "boolean" && value.values === undefined)
      possible.push({ value: true, measure: null }, { value: false, measure: null });
    else {
      const restricted = possibleValues(value);
      if (restricted === undefined) return false;
      for (const each of restricted) possible.push(each);
    }
  }
  return (
    possible.length > 0 &&
    possible.every(({ value, measure }) =>
      taken.some((literal) => literal.value === value && literal.measure === measure),
    )
  );
}

/** The earlier `case is T` or `case is not T` that already takes a literal case value, if any. */
function takingTypeCase<
  Case extends { readonly typeTest: SwitchTypeTest; readonly test: StaticType },
>(typeCases: readonly Case[], value: Expression, valueType: StaticType): Case | undefined {
  if (caseValueText(value) === undefined) return undefined;
  // Every duration literal is a duration, also a calendar one such as `1 d` that is not compared as one exact length,
  // and every angle literal an angle.
  const measure = isScalar(valueType, "duration")
    ? "duration"
    : isScalar(valueType, "angle")
      ? "angle"
      : null;
  const literal = measure === null ? comparedLiteral(value)?.[0] : undefined;
  if (measure === null && literal === undefined) return undefined;
  const scalar = literal?.value;
  // Like the runtime type test: a whole number such as `5.0` is an integer.
  const passes = (member: StaticType): boolean =>
    member.kind === "null"
      ? scalar === null
      : member.kind === "scalar" &&
        (measure !== null
          ? member.name === measure
          : typeof scalar === "number"
            ? member.name === "number" || (member.name === "integer" && Number.isInteger(scalar))
            : member.name === typeof scalar);
  return typeCases.find(({ typeTest, test }) => members(test).some(passes) !== typeTest.negated);
}

/** Literal values as an author writes them, as in `"spank" or "lines"`, `2 seconds`, or `90°`. */
function describeLiterals(values: readonly PossibleValue[]): string {
  const written = values.map(({ value, measure }) =>
    typeof value === "string"
      ? JSON.stringify(value)
      : measure === "duration" && typeof value === "number"
        ? formatDuration(value)
        : measure === "angle" && typeof value === "number"
          ? formatAngle(angleValue(value))
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

/** Why a button cannot return a value of this member type, which it may show: a script reference or a regex. */
function unreturnableChoiceMessage(member: StaticType): string | undefined {
  for (const [name, description] of [
    ["script", "a script reference"],
    ["regex", "a regex"],
  ] as const)
    if (isScalar(member, name))
      return `A button cannot return ${description}. Give the buttons text or number values, and pick ${description.replace("a ", "the ")} from the answer.`;
  return undefined;
}

/** Whether a button may return a value of this member type: one that is shown, other than a script reference or regex. */
function isChoiceValue(member: StaticType): boolean {
  return isShowable(member) && unreturnableChoiceMessage(member) === undefined;
}

const MIN_MAX_NAMES: ReadonlySet<string> = new Set(["min", "max"]);

/** The result types of the built-ins that take fixed positional arguments. */
const FIXED_RESULTS: ReadonlyMap<string, StaticType> = new Map([
  ["random", NUMBER_TYPE],
  ["chance", BOOLEAN_TYPE],
  ["randomInteger", INTEGER_TYPE],
  ["escapeMarkup", STRING_TYPE],
]);

/** Speaker properties shown as text: the display name and the parts it is derived from. */
const SPEAKER_TEXT_PROPERTIES: ReadonlySet<string> = new Set([
  "displayName",
  "title",
  "shortTitle",
  "firstName",
  "lastName",
]);

/**
 * A speaker's built-in properties (V30 §37), which the runtime checks where it uses them; any other property is a custom
 * one, which keeps its type unless a store reaches it unchecked (see {@link UncheckedProperties}).
 */
const BUILT_IN_SPEAKER_PROPERTIES: ReadonlySet<string> = new Set([
  ...SPEAKER_TEXT_PROPERTIES,
  "alias",
  "gender",
  "color",
  "font",
  "avatar",
  "presentation",
  "bubble",
  "prose",
  "defaultSaySkippable",
]);

/**
 * The built-in properties of a speaker that it has only once a declaration or an assignment gives it: those of
 * {@link BUILT_IN_SPEAKER_PROPERTIES}, the gender terms, and the name lists (V30 §37). A read of one that the speaker
 * never gets anywhere in the project is a compile error, as of a custom property (see {@link fieldSources}).
 */
const SPEAKER_FIELDS: ReadonlySet<string> = new Set([
  ...BUILT_IN_SPEAKER_PROPERTIES,
  ...GENDER_TERMS.keys(),
  ...SPEAKER_NAME_LISTS,
]);

/** The stores of each `player.copyFrom(account)` (see {@link copyStores}), made once for each, so every check sees them. */
const COPY_STORES = new WeakMap<CallExpression, readonly AssignmentStatement[]>();

/**
 * The stores `player.<field> = account.<field>` that `player.copyFrom(account)` stands for in the type check, one for
 * each person field, at the call's place.
 */
function copyStores(call: CallExpression): readonly AssignmentStatement[] {
  const made = COPY_STORES.get(call);
  if (made !== undefined) return made;
  const span = call.span;
  const named = (name: string): Identifier => ({ kind: "identifier", name, span });
  const field = (object: string, name: string): PropertyAccessExpression => ({
    kind: "propertyAccessExpression",
    object: named(object),
    property: named(name),
    span,
  });
  const stores = [...PERSON_FIELDS].map((name): AssignmentStatement => ({
    kind: "assignmentStatement",
    operator: "=",
    target: field(PLAYER, name),
    value: field("account", name),
    span,
  }));
  COPY_STORES.set(call, stores);
  return stores;
}

/** Whether `expression` is the protected `account`, which no binding can have as its name. */
function isAccountName(expression: Expression): boolean {
  const node = unwrap(expression);
  return node.kind === "identifier" && node.name === "account";
}

/**
 * The fields of which a speaker needs one for a read of its field `name` to find a value: `title` and `shortTitle` stand
 * for each other, a term's default comes from `gender`, and a display name may be joined from the parts of the name.
 */
function fieldSources(name: string): readonly string[] {
  if (name === "title" || name === "shortTitle") return ["title", "shortTitle"];
  if (name === "displayName")
    return ["displayName", "title", "shortTitle", "firstName", "lastName"];
  return GENDER_TERMS.has(name) ? [name, "gender"] : [name];
}

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

const EMPTY_FIELD_FIX = " Remove 'prefill:' to start with an empty field.";

/** How to offer a non-text prefill as text: interpolate it explicitly. */
function textPrefillFix(expression: Expression, name: string | null): string {
  if (name !== null) return ` Write it as text: 'prefill: "\${${name}}"'.`;
  const literal = unwrap(expression);
  if (literal.kind === "numberLiteral")
    return ` Write it as text: 'prefill: "${numberAnswerText(literal.value)}"'.`;
  return " Write it as text with interpolation: 'prefill: \"${...}\"'.";
}

/** How to offer a number prefill: write number text as a number. */
function numberPrefillFix(expression: Expression): string {
  const text = staticVisibleText(expression);
  return text !== undefined && isValidInteractionPrefill("number", text)
    ? ` Write it as a number: 'prefill: ${text.trim()}'.`
    : " Use a number, such as 'prefill: 10'.";
}

const NEGATIVE_INDEX_MESSAGE =
  "A list index cannot be negative. The first element is at index 0, and the last at length - 1.";

/** Whether `expression` is `true` as written, also in parentheses. */
function isTrueLiteral(expression: Expression): boolean {
  const value = unwrap(expression);
  return value.kind === "booleanLiteral" && value.value;
}

function unwrap(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

/** Whether the compiler knows that a value of `type` is never null: it knows every member, and none is null. */
function neverNull(type: StaticType): boolean {
  const all = members(type);
  return all.every(isKnown) && !all.some((member) => member.kind === "null");
}

/**
 * The type of `value otherwise fallback` (V30 §18): the value where it is never null, the fallback where it is only
 * null, and otherwise both, joined as for a list `get` default: where the fallback has a part that no value decided
 * yet, such as `[]`, as in a literal, and otherwise as a union, so an undecided part of the value is not decided by its
 * fallback.
 *
 * A value whose own type no value decided yet, such as `x` after `let x = null` once a load or a call may have stored
 * in it, counts as what a read of it gives elsewhere (#859): a value the compiler cannot know where one reached it, and
 * otherwise only null so far, which a fallback of known type other than null replaces, as `if x == null { x = 0 }`
 * would. Where a later value decides it, the next check starts with that type, as for any read that saw it undecided.
 * Where the next check cannot start with it, `keep` keeps the place in the result, as a union. The places replaced are
 * added to `replaced`.
 */
function fallbackType(
  value: StaticType,
  fallback: StaticType,
  keep = false,
  replaced: OpenType[] = [],
): StaticType {
  if (neverNull(value)) return value;
  let kept = nonNullType(value);
  const slots = members(kept).filter((member): member is OpenType => member.kind === "open");
  if (slots.length > 0 && decidedValue(fallback).kind !== "never") {
    if (slots.some((slot) => slot.heldUnknown !== undefined)) return UNKNOWN_TYPE;
    if (!keep) {
      replaced.push(...slots);
      kept = decidedValue(kept);
    }
  }
  if (resolved(kept).kind === "never") return fallback;
  const undecided = (type: StaticType): boolean =>
    containsType(type, (part) => part.kind === "open");
  const joined = undecided(fallback) && !undecided(kept) ? joinTypes([kept, fallback]) : undefined;
  return joined ?? union([kept, fallback]);
}

/** A fallback as source text for a fix that shows it, also `true`, `false`, `null`, and `[]`. */
function fallbackText(expression: Expression): string | null {
  const node = unwrap(expression);
  if (node.kind === "booleanLiteral") return String(node.value);
  if (node.kind === "nullLiteral") return "null";
  if (node.kind === "listLiteral" && node.elements.length === 0) return "[]";
  return expressionText(expression);
}

/** A slot already decided by its first value at `at`, so a later mismatch can name that line. */
function decidedSlot(type: StaticType, at: SourceSpan): StaticType {
  // A place still undecided, such as one that so far took only null, is decided by its first other value instead.
  if (members(type).some((member) => member.kind === "open")) return type;
  const slot = openType();
  slot.resolved = type;
  slot.resolvedAt = at;
  slot.order = nextDecision();
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

/** The code of a problem with a member of a handle or permanent button (see `handle-rules.ts`). */
function handleMemberCode(kind: StaticType["kind"]): TypeErrorCode {
  return kind === "timer"
    ? typeCode.invalidTimerHandleMember
    : kind === "media"
      ? typeCode.invalidMediaHandleMember
      : kind === "camera"
        ? typeCode.invalidCameraHandleMember
        : typeCode.invalidOperand;
}

/**
 * The message for a method call on a receiver that is a speaker, which has properties but no methods (V30 §37). In a
 * union, the example property would first need a check that the value is a speaker, so a union gets the plain message.
 */
function speakerMethodMessage(method: string, label: string | null): string {
  return `A speaker has no methods, so it has no '${method}'. Use one of its properties instead, such as '${label === null ? "" : `${label}.`}title'.`;
}

/**
 * `wait 15 + randomInteger(0..35) s` gives the unit to the call alone, so a number is added to a duration: the whole
 * expression goes in parentheses with the unit after them (ADR 0026 §8).
 */
function groupedUnitMessage(
  command: "wait" | "timer" | "duration:",
  expression: Extract<Expression, { kind: "unaryExpression" | "binaryExpression" }>,
  operands: readonly StaticType[],
): string | null {
  if (expression.kind !== "binaryExpression" || operands.length !== 2) return null;
  const right = expression.right;
  if (right.kind !== "durationLiteral" && right.kind !== "unitExpression") return null;
  if (!isNumeric(operands[0]!) || !isScalar(operands[1]!, "duration")) return null;
  const left = expressionText(expression.left);
  const amount = expressionText(right.kind === "durationLiteral" ? right.amount : right.operand);
  if (left === null || amount === null) return null;
  return `A duration and a number cannot be combined with '${expression.operator}'. Put the expression in parentheses with the unit after them, such as '${command} (${left} ${expression.operator} ${amount}) ${right.unit}'.`;
}

/**
 * Whether an operation failed on a duration and a number, which have their own code (TSV035). `%` takes no duration
 * whatever the other operand is.
 */
function mixesDurationAndNumber(operator: string, operands: readonly StaticType[]): boolean {
  if (operands.length !== 2 || operator === "%") return false;
  const duration = (type: StaticType): boolean => isScalar(type, "duration", "calendarDuration");
  const [left, right] = [operands[0]!, operands[1]!];
  return (duration(left) && isNumeric(right)) || (isNumeric(left) && duration(right));
}

function operatorMessage(
  operator: string,
  expression: Extract<Expression, { kind: "unaryExpression" | "binaryExpression" }>,
  operands: readonly StaticType[],
  typeOf: (expression: Expression) => StaticType,
): string {
  const [left, right] = operands;
  if (operands.length === 1)
    return `'${operator}' needs a number, a duration, or an angle, but this is ${describeValue(left!)}.`;
  const duration = (type: StaticType): boolean => isScalar(type, "duration", "calendarDuration");
  // A calendar day or month has no fixed length, so it has no order or ratio against exact time (ADR 0026).
  const mixedDurations =
    (isScalar(left!, "calendarDuration") && isScalar(right!, "duration")) ||
    (isScalar(left!, "duration") && isScalar(right!, "calendarDuration"));
  if (["<", "<=", ">", ">="].includes(operator)) {
    if (mixedDurations)
      return `'${operator}' cannot compare a calendar duration with a duration. A calendar day or month has no fixed length. Compare two calendar durations, or two durations.`;
    const temporal = isTemporal(left!) ? left! : isTemporal(right!) ? right! : undefined;
    if (temporal !== undefined)
      return `'${operator}' compares ${describeValue(temporal)} only with another ${temporalNoun(temporal)}, not with ${describeValue(temporal === left ? right! : left!)}.${expression.kind === "binaryExpression" ? temporalPairFix(expression, operator, left!, right!) : ""}`;
    return `'${operator}' compares two numbers, two texts, two durations, two calendar durations, or two angles, but these are ${describeValue(left!)} and ${describeValue(right!)}.`;
  }
  if (operator === "/" && mixedDurations)
    return "'/' cannot divide a calendar duration and a duration by each other. A calendar day or month has no fixed length. Divide two calendar durations, or two durations.";
  const joined =
    operator === "+" && expression.kind === "binaryExpression"
      ? joinMessage(expression, left!, right!)
      : undefined;
  if (joined !== undefined) return joined;
  const angle = (type: StaticType): boolean => isScalar(type, "angle");
  if (angle(left!) || angle(right!)) {
    const binary = expression.kind === "binaryExpression" ? expression : null;
    // A unit binds tighter than an operator, so `pi / 6 rad` divides a number by an angle.
    const grouped = binary !== null && isNumeric(left!) ? groupedAngleText(binary, typeOf) : null;
    const group =
      grouped === null ? "" : ` Or group the numbers before the unit, as in '${grouped}'.`;
    if (
      (operator === "+" || operator === "-") &&
      binary !== null &&
      (isNumeric(left!) || isNumeric(right!))
    )
      return `An angle and a number cannot be combined with '${operator}'. ${unitFix(isNumeric(left!) ? binary.left : binary.right, angleUnitOf(isNumeric(left!) ? binary.right : binary.left))}${group}`;
    if (grouped !== null)
      return `'${operator}' cannot combine a number and an angle. Group the numbers before the unit, as in '${grouped}'.`;
    return `'${operator}' cannot combine ${describeValue(left!)} and ${describeValue(right!)}. ${ANGLE_ARITHMETIC_ROUTE}`;
  }
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
    const label = expressionLabel(expression.left) ?? "value";
    // No operator reads a zone (ADR 0026), so local and absolute values each move only one way.
    if (isScalar(left!, "date") && isScalar(right!, "duration")) {
      const literal = unwrap(expression.right);
      return literal.kind === "durationLiteral" &&
        !literal.calendar &&
        (literal.unit === "d" || literal.unit === "w")
        ? `A date moves only by calendar units. Write '${literal.amount.raw} calendar ${literal.unit === "d" ? "day" : "week"}${literal.amount.raw === "1" ? "" : "s"}'.`
        : "A date moves only by calendar units, such as '1 calendar day'.";
    }
    if (isScalar(left!, "datetime") && isScalar(right!, "duration"))
      return `A date and time has no time zone, so it cannot move by elapsed time. Convert it first, as in '(${label}.toAbsoluteDateTime() ${operator} ${durationText(expression.right)}).toDateTime()', or use calendar units to keep the clock time.`;
    if (operator === "-" && isScalar(left!, "datetime") && isScalar(right!, "datetime"))
      return `A date and time has no time zone, so one cannot be subtracted from another. Subtract their dates with 'toDate(${label}) - toDate(${expressionLabel(expression.right) ?? "value"})', or convert both with toAbsoluteDateTime() for the elapsed time.`;
    if (isScalar(left!, "absoluteDateTime") && isScalar(right!, "calendarDuration"))
      return `An absolute date and time has no calendar. Convert it first, as in '(${label}.toDateTime() ${operator} ${durationText(expression.right, "1 calendar day")}).toAbsoluteDateTime()'.`;
    // An absolute date and time or a date and time moves by a duration written after it.
    if (isScalar(left!, "absoluteDateTime", "datetime")) {
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
    if (operator === "+" && duration(left!) && isScalar(right!, "absoluteDateTime", "datetime"))
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
  const range = (type: StaticType): boolean => resolved(type).kind === "range";
  const text = (type: StaticType): boolean => isScalar(type, "string");
  const value = (operand: Expression): string => operandLabel(operand) ?? "value";
  const named = (operand: Expression, kind: string): string => expressionLabel(operand) ?? kind;
  if ((set(left) || set(right)) && (list(left) || list(right) || (set(left) && set(right))))
    return `'+' joins two texts or two lists, not ${describeValue(left)} and ${describeValue(right)}. ${SET_JOIN_FIX}`;
  if (list(left) && !list(right)) {
    const items = named(expression.left, "list");
    const fix = range(right)
      ? `To add the numbers of a range, write '${items} + ${rangeListText(expression.right)}'.`
      : `To add one element, use '${items}.add(${value(expression.right)})', or write '${items} + [${value(expression.right)}]' for a new list.`;
    return `'+' joins a list only with another list, not with ${describeValue(right)}. ${fix}`;
  }
  if (text(left) !== text(right) && (text(left) || !list(right))) {
    const other = text(left) ? right : left;
    const fix = isShowable(other)
      ? ` Put the value in the text instead, as in ${interpolationFix(expression)}.`
      : "";
    return `'+' joins text only with other text, not with ${describeValue(other)}.${fix}`;
  }
  if (list(right) && !list(left))
    return `'+' joins a list only with another list, not with ${describeValue(left)}. ${range(left) ? `To add the numbers of a range, write '${rangeListText(expression.left)} + ${named(expression.right, "list")}'.` : `Write '[${value(expression.left)}] + ${named(expression.right, "list")}' for a new list.`}`;
  return undefined;
}

const SET_JOIN_FIX = "Join sets with union(), or copy a set into a list with toList() first.";

/** `"Score: ${5}"` for `"Score: " + 5`: plain text as it is written, and the other operand interpolated. */
function interpolationFix(expression: Extract<Expression, { kind: "binaryExpression" }>): string {
  const part = (operand: Expression): string =>
    plainText(operand) ?? `\${${operandLabel(operand) ?? "value"}}`;
  return `"${part(expression.left)}${part(expression.right)}"`;
}

/**
 * The `toList()` call that gives the numbers of the range `operand`, as source text: `r.toList()` for one in a variable,
 * `(1..=3).toList()` for one written with an operator, which binds less tightly than a method call, and
 * `range.toList()` for one too long to show.
 */
function rangeListText(operand: Expression): string {
  const text = expressionText(operand);
  if (text === null) return "range.toList()";
  return POSTFIX_OPERANDS.has(operand.kind) ? `${text}.toList()` : `(${text}).toList()`;
}

/** The expressions a method call can follow without parentheses. */
const POSTFIX_OPERANDS: ReadonlySet<Expression["kind"]> = new Set([
  "identifier",
  "propertyAccessExpression",
  "indexExpression",
  "callExpression",
  "parenthesizedExpression",
]);

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

/** A number as a fix shows it, without float noise. */
/**
 * Why a calendar amount gives no whole days or months, with the fix: whole calendar units, or exact hours for days and
 * weeks (V30 §35).
 */
function calendarAmountMessage(reason: string, unit: string, amount: number): string {
  return unit === "d" || unit === "w"
    ? `${reason}. Use whole calendar days, or exact hours such as '${formatNumberText(amount * (unit === "d" ? 24 : 168))} h'.`
    : `${reason}. Use whole calendar months.`;
}

function formatNumberText(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** A duration operand as a fix shows it: its name, or a duration literal with its unit, else `example`. */
function durationText(expression: Expression, example = "2 h"): string {
  const literal = unwrap(expression);
  if (literal.kind !== "durationLiteral") return expressionLabel(expression) ?? example;
  if (!literal.calendar) return `${literal.amount.raw} ${literal.unit}`;
  const word = { d: "day", w: "week", mo: "month", y: "year" }[literal.unit];
  return `${literal.amount.raw} calendar ${word}${literal.amount.raw === "1" ? "" : "s"}`;
}

/** What a date or time value is called after "another", such as `date and time`. */
function temporalNoun(type: StaticType): string {
  return describeValue(type).replace(/^an? /u, "");
}

/**
 * How to compare or subtract a date and time and a value of another kind: convert one of them. A date and time and an
 * absolute date and time convert through the player's zone; a date or a time is compared with that part of a date and
 * time.
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
  if (isScalar(other, "absoluteDateTime"))
    return ` Convert one first, as in '${label}.toAbsoluteDateTime()'.`;
  if (operator === "-") return "";
  if (isScalar(other, "date")) return ` Compare its date, as in 'toDate(${label})'.`;
  if (isScalar(other, "time")) return ` Compare its time, as in 'toTime(${label})'.`;
  return "";
}

/** Give a time without a unit one, as a unit follows a number (ADR 0026 §8), in the command it is written in. */
function timeUnitFix(
  expression: Expression,
  command: "wait" | "timer" | "named timer" | "media",
  range: boolean,
): string {
  if (command === "media") return unitFix(expression);
  const form = unitForm(expression);
  const written = command === "named timer" ? "duration:" : command;
  return form === null
    ? "Put the expression in parentheses with a unit after them."
    : `Give the ${range ? "range" : "number"} a unit, such as '${written} ${form}'.`;
}

/**
 * `n op a unit` as the author likely meant it, `(n op a) unit`, when the right operand is a number with an angle unit
 * written directly after it; `null` otherwise, or when the source is too long to show.
 */
function groupedAngleText(
  expression: Extract<Expression, { kind: "binaryExpression" }>,
  typeOf: (expression: Expression) => StaticType,
): string | null {
  const right = expression.right;
  if (right.kind !== "angleExpression" || !isNumeric(nonNullTypeForUse(typeOf(right.operand))))
    return null;
  const left = expressionText(expression.left);
  const amount = expressionText(right.operand);
  return left === null || amount === null
    ? null
    : `(${left} ${expression.operator} ${amount}) ${right.unit}`;
}

/** The angle unit written on an angle operand, or `deg` when none is written there. */
function angleUnitOf(operand: Expression): "deg" | "rad" {
  return operand.kind === "angleExpression" ? operand.unit : "deg";
}

/** Give a number a unit: `'5 s'`, `'count s'`, or `'(count + 1) s'`, or an angle unit, as in `'90 deg'`. */
function unitFix(number: Expression | null, unit: "s" | "deg" | "rad" = "s"): string {
  const form = number === null ? (unit === "s" ? "5 s" : `90 ${unit}`) : unitForm(number, unit);
  return form === null
    ? "Put the expression in parentheses with a unit after them."
    : `Give the number a unit, such as '${form}'.`;
}

/**
 * An expression with `unit` after it as the source would need it: directly after a number literal, a name, a member,
 * a call, or parentheses, and otherwise after added parentheses. `null` when the expression is too long to show.
 */
function unitForm(expression: Expression, unit = "s"): string | null {
  const text = expressionText(expression);
  if (text === null) return null;
  return expression.kind === "numberLiteral" || UNIT_OPERANDS.has(expression.kind)
    ? `${text} ${unit}`
    : `(${text}) ${unit}`;
}

/**
 * An expression as source text, for a fix that shows it: literals, names, members, calls, and operators. `null` for
 * any other expression, and for one longer than a message can show.
 */
function expressionText(expression: Expression, depth = 0): string | null {
  if (depth > 6) return null;
  const child = (node: Expression): string | null => expressionText(node, depth + 1);
  const all = (nodes: readonly (string | null)[]): nodes is readonly string[] =>
    nodes.every((node) => node !== null);
  let text: string | null = null;
  switch (expression.kind) {
    case "numberLiteral":
      text = expression.raw;
      break;
    case "identifier":
      text = expression.name;
      break;
    case "durationLiteral":
      text = `${expression.amount.raw} ${expression.calendar ? "calendar " : ""}${expression.unit}`;
      break;
    case "stringLiteral": {
      const plain = plainText(expression);
      text = plain === null ? null : `"${plain}"`;
      break;
    }
    case "propertyAccessExpression": {
      const object = child(expression.object);
      text = object === null ? null : `${object}.${expression.property.name}`;
      break;
    }
    case "parenthesizedExpression": {
      const inner = child(expression.expression);
      text = inner === null ? null : `(${inner})`;
      break;
    }
    case "indexExpression": {
      const parts = [child(expression.object), child(expression.index)];
      text = all(parts) ? `${parts[0]}[${parts[1]}]` : null;
      break;
    }
    case "unitExpression": {
      const operand = child(expression.operand);
      text =
        operand === null
          ? null
          : `${operand} ${expression.calendar ? "calendar " : ""}${expression.unit}`;
      break;
    }
    case "unaryExpression": {
      const operand = child(expression.operand);
      text =
        operand === null
          ? null
          : `${expression.operator === "not" ? "not " : expression.operator}${operand}`;
      break;
    }
    case "binaryExpression": {
      const parts = [child(expression.left), child(expression.right)];
      text = all(parts) ? `${parts[0]} ${expression.operator} ${parts[1]}` : null;
      break;
    }
    case "rangeExpression": {
      const parts = [child(expression.start), child(expression.end)];
      text = all(parts) ? `${parts[0]}${expression.inclusive ? "..=" : ".."}${parts[1]}` : null;
      break;
    }
    case "callExpression": {
      if (expression.arguments.length > 6) return null;
      const parts = [
        child(expression.callee),
        ...expression.arguments.map((argument) => {
          const value = child(argument.value);
          return value === null || argument.kind === "positionalArgument"
            ? value
            : `${argument.name.name}: ${value}`;
        }),
      ];
      text = all(parts) ? `${parts[0]}(${parts.slice(1).join(", ")})` : null;
      break;
    }
  }
  return text !== null && text.length <= 60 ? text : null;
}

/**
 * How to make a value fit `+=`/`-=` on a place of `operand` type: text takes it inside the text, and a list takes one
 * element with `add` (V30 §4).
 */
function operandFix(operand: StaticType, type: StaticType, statement: AssignmentStatement): string {
  if (isNumeric(operand)) return " Use a number instead.";
  const literal = unwrap(statement.value);
  if (literal.kind === "numberLiteral" && isScalar(operand, "duration", "absoluteDateTime"))
    return ` Give the number a unit, such as '${literal.raw} s'.`;
  if (literal.kind === "numberLiteral" && isScalar(operand, "angle"))
    return ` Give the number a unit, such as '${literal.raw} deg'.`;
  if (isScalar(operand, "angle")) return " Use an angle such as '90 deg' instead.";
  // No operator reads a zone (ADR 0026): local values move by calendar units, absolute ones by durations.
  if (isScalar(operand, "date") && isScalar(type, "duration"))
    return " Use calendar units, such as '1 calendar day'.";
  if (isScalar(operand, "absoluteDateTime") && isScalar(type, "calendarDuration"))
    return " Convert it with toDateTime() first.";
  if (isScalar(operand, "duration", "absoluteDateTime"))
    return " Use a duration such as '2 s' instead.";
  if (isScalar(operand, "date", "datetime"))
    return " Use a calendar duration such as '1 calendar day' instead.";
  const target = expressionLabel(statement.target);
  if (statement.operator !== "+=" || target === null) return "";
  const value = operandLabel(statement.value) ?? "value";
  if (isScalar(operand, "string") && isShowable(type))
    return ` Put the value in the text instead, as in '${target} += "\${${value}}"'.`;
  if (resolved(operand).kind === "list" && resolved(type).kind === "range")
    return ` To add the numbers of a range, use '${target} += ${rangeListText(statement.value)}'.`;
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
  if (isScalar(kept, "angle") && isNumeric(value)) return ` ${unitFix(expression, "deg")}`;
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

/** The source of an operation on variables, properties, or numbers, such as `x / 4`; `null` for anything longer. */
function operationText(expression: Expression): string | null {
  const operation = unwrap(expression);
  const operand = (part: Expression): string | null => expressionLabel(part) ?? literalText(part);
  if (operation.kind === "unaryExpression") {
    const text = operand(operation.operand);
    return text === null ? null : `${operation.operator}${text}`;
  }
  if (operation.kind !== "binaryExpression") return null;
  const [left, right] = [operand(operation.left), operand(operation.right)];
  return left === null || right === null ? null : `${left} ${operation.operator} ${right}`;
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
  const or = test === "!= null" ? fallbackFix(label ?? "value", passing) : "";
  return label === null
    ? ` Keep it in a variable and check it first, as in: if value ${test} { ... }${or}`
    : ` Check it first: if ${label} ${test} { ... }${or}`;
}

/**
 * How a fix gives a place the type written as `type` where `declared` says: as in `declare it as 'let items: string[] =
 * ...'`, `declare the parameter as 'count: number = 1'`, or for a property, through its first value.
 */
function declareAs(declared: NonNullable<Declared>, type: string): string {
  switch (declared.kind) {
    case "parameter": {
      const { name, defaultValue } = declared.parameter;
      const start = defaultValue === null ? "" : ` = ${sourceText(defaultValue) ?? "..."}`;
      return `declare the parameter as '${name.name}: ${type}${start}'`;
    }
    case "property":
      return `give '${declared.label}' a first value of type ${type}, such as a variable declared with that type`;
    default:
      return `declare it as '${declared.kind} ${declared.name}: ${type} = ...'`;
  }
}

/** How a fix for a mixed collection declares a union element type: on the collection `declared` names, or on another. */
function keepBothFix(declared: Declared, written: string): string {
  if (declared?.kind === "parameter") return `to keep both, ${declareAs(declared, written)}`;
  const head =
    declared?.kind === "let" || declared?.kind === "global"
      ? `${declared.kind} ${declared.name}`
      : "let values";
  return `to keep both, declare a union type, as in '${head}: ${written} = ...'`;
}

/** A short suggestion for the most common mismatches of a variable, which `declared` declares unless it is a loop's. */
function typeFix(
  declared: Declared,
  target: StaticType,
  value: StaticType,
  expression: Expression | null,
): string {
  const nullable = isNullable(target);
  const kept = resolved(nonNullType(target));
  if (resolved(value).kind === "null" && !nullable)
    return declared !== null && isAnnotatable(target)
      ? ` To allow null, ${declareAs(declared, `${typeName(target)}?`)}.`
      : " Use a separate variable for null.";
  if (isScalar(kept, "integer") && isScalar(value, "number"))
    return declared === null
      ? `${ROUND_FIX}.`
      : `${ROUND_FIX}, or ${declareAs(declared, `number${nullable ? "?" : ""}`)}.`;
  const conversion = conversionFix(target, value, expression);
  if (conversion !== undefined) return conversion;
  const both = union([target, value]);
  return declared !== null && isAnnotatable(both)
    ? ` To allow both, ${declareAs(declared, typeName(both))}.`
    : " Use a separate variable for a value of another type.";
}

/** Like {@link typeFix}, for an argument or default of a parameter: a declaration in the function's parameter list. */
function parameterFix(
  parameter: FunctionParameter,
  target: StaticType,
  value: StaticType,
  expression: Expression | null,
): string {
  const declared: Declared = { kind: "parameter", parameter };
  const kept = resolved(nonNullType(target));
  if (isScalar(kept, "integer") && isScalar(value, "number"))
    return `${ROUND_FIX}, or ${declareAs(declared, "number")}.`;
  const conversion = conversionFix(target, value, expression);
  if (conversion !== undefined) return conversion;
  const both = union([target, value]);
  if (!isAnnotatable(both)) return " Use a value of the parameter's type.";
  return ` To allow both, ${declareAs(declared, typeName(both))}.`;
}

function sourceText(expression: Expression): string | null {
  const literal = unwrap(expression);
  if (literal.kind === "numberLiteral") return literal.raw;
  if (literal.kind === "booleanLiteral") return String(literal.value);
  return null;
}

/**
 * The message for a change of `changed` that lands in `copy`, a value no variable holds. For a call, such as `obj()`,
 * it shows how to keep the value in a variable named by the call's first letter and change it there, as in `o.n`.
 */
function changedCopyMessage(changed: Expression, copy: Expression): string {
  const callee = copy.kind === "callExpression" ? expressionLabel(copy.callee) : null;
  if (copy.kind !== "callExpression" || callee === null)
    return "This changes a copy that no variable holds, so the change is lost. Store the value in a variable first, then change the variable.";
  const call = `${callee}(${copy.arguments.length > 0 ? "..." : ""})`;
  const initial = callee
    .slice(callee.lastIndexOf(".") + 1)
    .charAt(0)
    .toLowerCase();
  const name = /^[a-z]$/.test(initial) && initial !== callee ? initial : "value";
  const steps: string[] = [];
  for (let node = changed; node !== copy;) {
    if (node.kind === "parenthesizedExpression") node = node.expression;
    else if (node.kind === "propertyAccessExpression") {
      steps.push(`.${node.property.name}`);
      node = node.object;
    } else if (node.kind === "indexExpression") {
      const index = unwrap(node.index);
      steps.push(
        `[${index.kind === "numberLiteral" ? index.raw : index.kind === "identifier" ? index.name : "..."}]`,
      );
      node = node.object;
    } else break;
  }
  return `This changes a copy that no variable holds: '${call}' gives a new value each time, so the change is lost. Store it in a variable first, as in 'let ${name} = ${call}', then change '${name}${steps.reverse().join("")}'.`;
}

/**
 * The message for a change of the value that `read`, a property of a value of kind `owner`, computes when it is read,
 * such as `d.values`: it names where to make the change instead.
 */
function computedCopyMessage(
  read: Extract<Expression, { kind: "propertyAccessExpression" }>,
  owner: StaticType["kind"],
): string {
  const name = read.property.name;
  const receiver =
    expressionLabel(read.object) ?? (owner === "dict" || owner === "set" ? owner : "value");
  const property = `'${receiver}.${name}'`;
  const lost = `This changes a copy that no variable holds: ${property}`;
  if (owner === "set")
    return `${lost} gives a copy of the member, so the change is lost. To change the set, replace the member: 'let member = ${receiver}.${name}', '${receiver}.remove(member)', then change 'member' and '${receiver}.add(member)'.`;
  if (owner === "dict" && name === "keys")
    return `${lost} gives a new list each time, so the change is lost. Change the dict itself, as in '${receiver}[key] = value' or '${receiver}.remove(key)'.`;
  if (owner === "dict" && name === "values")
    return `${lost} gives a new list each time, so the change is lost. Change the dict through its keys, as in '${receiver}[key]'.`;
  return `${lost} gives a new value each time, so the change is lost. Store it in a variable first, as in 'let value = ${receiver}.${name}', then change the variable.`;
}

/**
 * How to let a function return values of two types: declare a union result type of `earlier`, what the returns before
 * gave, and `other`.
 */
function returnUnionFix(
  declaration: FunctionDeclaration,
  earlier: StaticType,
  other: StaticType,
): string {
  const both = union([earlier, other]);
  if (!isAnnotatable(both))
    return " A function returns one type. Use a separate function for values of another type.";
  return ` To return both, declare the result type, as in '${functionHead(declaration)}: ${typeName(both)}'.`;
}

/** The start of a function's declaration as a fix writes it: `function name`, with `(...)` when it has parameters. */
function functionHead(declaration: FunctionDeclaration): string {
  return `function ${declaration.name.name}${declaration.parameters.length === 0 ? "" : "(...)"}`;
}

/** How a function with a declared result may also return null. */
function optionalResultFix(declared: StaticType): string {
  return isAnnotatable(declared)
    ? ` To allow null, declare the result as '${typeName(declared)}?'.`
    : "";
}

/**
 * How to make a value fit a list or set: allow fractions or both where `declared` writes the collection's type, or keep
 * other values in a separate collection.
 */
function elementFix(
  declared: Declared,
  collection: CollectionType,
  value: StaticType,
  nullable: boolean,
): string {
  const optional = nullable ? "?" : "";
  if (declared !== null && isScalar(collection.element, "integer") && isScalar(value, "number"))
    return ` To allow fractions, ${declareAs(declared, `${typeName({ kind: collection.kind, element: NUMBER_TYPE })}${optional}`)}.`;
  if (isScalar(collection.element, "duration") && isNumeric(value))
    return " Give the number a unit, such as '5 s'.";
  if (isScalar(collection.element, "angle") && isNumeric(value))
    return " Give the number a unit, such as '90 deg'.";
  const both: StaticType = { kind: collection.kind, element: union([collection.element, value]) };
  if (declared !== null && isAnnotatable(both))
    return ` To allow both, ${declareAs(declared, `${typeName(both)}${optional}`)}.`;
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
  switch (member.result) {
    case "integer?":
      return optional(INTEGER_TYPE);
    case "string?":
      return optional(STRING_TYPE);
    case "string[]":
      return { kind: "list", element: STRING_TYPE };
    // The groups of a match, or null without one; a group that did not take part is null.
    case "string?[]?":
      return optional({ kind: "list", element: optional(STRING_TYPE) });
    default:
      return scalarType(member.result);
  }
}

/** The answer of an `askForm` field whose kind only the runtime knows. */
const GENERIC_FORM_ANSWER_TYPE = union([
  BOOLEAN_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  DATE_TYPE,
  TIME_TYPE,
  DATETIME_TYPE,
  // A cycle may return any choice value but `null`.
  DURATION_TYPE,
  CALENDAR_DURATION_TYPE,
  ANGLE_TYPE,
  ABSOLUTE_DATE_TIME_TYPE,
]);

/** The kind of an `askForm` field that starts with a value of `type`, or `null` when its kind is not known. */
function formKindOfStart(type: StaticType): FormFieldKind | null {
  if (type.kind === "list") return "cycle";
  if (type.kind !== "scalar") return null;
  switch (type.name) {
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
    case "date":
    case "time":
    case "datetime":
      return type.name;
    case "string":
      return "text";
    default:
      return null;
  }
}

function formAnswerType(kind: Exclude<FormFieldKind, "boolean" | "cycle">): StaticType {
  return kind === "text" ? STRING_TYPE : interactionResultType(kind);
}

/** The text of a string literal without interpolation, or `undefined`. */
function staticText(expression: Expression): string | undefined {
  const literal = unwrap(expression);
  if (literal.kind !== "stringLiteral" || literal.parts.some((part) => part.kind !== "stringText"))
    return undefined;
  return literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("");
}

/** The type of the answer an `ask...` interaction returns. */
function interactionResultType(
  kind: Exclude<
    InteractionExpression["interactionKind"],
    "choice" | "form" | "boolean" | "booleans"
  >,
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
    case "password":
      return STRING_TYPE;
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
