import type {
  AssignmentStatement,
  Expression,
  ForStatement,
  FunctionParameter,
  GlobalStatement,
  Identifier,
  LetStatement,
  LoadExpression,
  Program,
  SpeakerDeclaration,
  TypeAnnotation,
} from "../ast.js";
import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import { staticText, unwrap } from "../expression-children.js";
import type { TypePlan } from "../plan/model.js";
import { someNode } from "../project-globals.js";
import type { KnownValues } from "../static-evaluation.js";
import {
  BOOLEAN_TYPE,
  CALENDAR_DURATION_TYPE,
  DURATION_TYPE,
  INTEGER_TYPE,
  joinTypes,
  nonNullType,
  NULL_TYPE,
  NUMBER_TYPE,
  openType,
  PropertyTable,
  resolved,
  STRING_TYPE,
  typeFromAnnotation,
  UNKNOWN_TYPE,
  type StaticType,
} from "../static-types.js";
import {
  sameReadStorageKeyTypes,
  sameStorageKeyTypes,
  storageKeyTypes,
  typeKey,
  type StorageKeyType,
  type StorageLoad,
} from "../storage-types.js";
import { lineNamer, TypeChecker, withVisibleOverflows, type LineNamer } from "../type-checker.js";
import { typePlan } from "../type-plans.js";
import type {
  SolvedTypeFacts,
  TypeAnalysisBackend,
  TypeCheckOptions,
  TypeCheckResult,
} from "./backend.js";
import {
  coversDeadCode,
  projectEffects,
  sameProjectEffects,
  type DeadCode,
  type ProjectEffects,
} from "./effects.js";
import { legacyFacts } from "./legacy-facts.js";
import type {
  Copies,
  Decided,
  KeptFallbacks,
  UncheckedProperties,
  Widened,
} from "./legacy-state.js";

// The facts the legacy inference decides, what each depends on, and whether its answer depends on the order in
// which the check visits the source today (O4 stage 1 inventory, 2026-10-17; the replacement must decide the same
// facts from the same inputs without the order dependence, see docs/decisions/0021-static-types.md):
//
// | Fact | Decided from | Order-dependent today |
// |---|---|---|
// | Type of a `let` or `global` without a written type (`Variable`, `#letTask`, `#ownType`) | Initializer, every compatible store, widenings, copies | The first known non-null value decides the family; later stores check; widening to number restarts the check |
// | Numeric family, integer or number, also of nested parts (`Widened`, `Origins`, `#follow`, `widenFollowers`) | Literal spelling, arithmetic, stores into inferred places, what a value derives from | A later non-whole store widens earlier reads: recorded, then replayed in the next check, along chains of followers |
// | Null-only, undecided, dynamic, decided, optional places (`OpenType`, `settle`, `Decided`, `recordDecisions`) | Null stores, known values, values the compiler cannot know, copies | A read before the deciding store observes the slot; the decision is replayed to it in the next check; a value the compiler cannot know decides nothing but marks the slot (`heldUnknown`) |
// | Copies of undecided places (`Copies`, `copyType`, `decidingSlots`) | The copied expression, later decisions of the source | A copy shares the source's later decision; the first decision in checking order wins around cycles; a cycle that holds itself is not replayed |
// | Parameter types and the shape the body accepts (`FunctionType.parameters`, `.accepted`, `#parametersTask`) | Annotation or default; stores in the body may widen an integer default and add required properties | No call-site inference: a parameter without annotation or default is unknown; calls while the body is checked are checked once it is complete |
// | Function result and whether it may complete without a value (`#functionResultTask`, `#inferredResult`) | Every `return`, the declared result, fallthrough, recursive calls | The body is checked at its first needed call, or after the top level when it uses a later variable; a recursive call in progress gives the annotation or unknown |
// | Element and value types of lists, sets, and dicts (`TypeJoin`, `elementStoreType`, `#storeTask`) | Literal members, indexed stores, `add`, `addAll`, concatenation, copies, contextual annotations, non-null `get` defaults (`decides: "default"`) | An empty collection is decided by the first contributing value in checking order |
// | Object property types and which objects may reach a place (`PropertyTable`, `flowInto`, `missingPropertyReads`) | Object literals, stores, copies, nested and collection flows, unknown objects | The first value fixes a property's family; tables grow after reads, so missing-property reads are reported at the end from every possible source |
// | Speaker custom property types and the names no speaker keeps a type for (`#speakerProperties`, `UncheckedProperties`) | Speaker declarations, stores through a speaker's name, stores through a speaker the compiler cannot tell apart | A store found unchecked discards what earlier checks inferred for that name, for every speaker, and the check restarts with the larger set |
// | Storage key types from literal keys, each load's view, and the saves that must fit them (`storageGuess`, `storageLoads`, `storageKeyTypes`) | Declared types at loads, every other load of the key in any file, literal defaults | The first check reads a syntactic guess; a check that read a type it did not find restarts; at most `MAX_STORAGE_ROUNDS` changes; a load that read its default's type decides again when another load declares the key |
// | Declared unions against the alternatives an operation gives (`union`, `TypeJoin`, mixed literals and choices) | Annotations, operation contracts such as `get` and `otherwise`, collection and return uniformity | Discovery order decides when a mixed literal or choice is reported, not whether |
// | `otherwise` results and kept fallbacks (`fallbackType`, `KeptFallbacks`, `#replaced`) | The left operand without null, the fallback's type, null-only against dynamic evidence | A null-only left operand replaced by the fallback keeps that place when a later value decides it in a way the next check cannot start with |
// | Types at a program point: narrowing, assignment, joins, loops, suspensions (`Flow`, `assignedType`, `narrowTo`, `excludeType`) | Tests, stores, branch joins, early exits, source evaluation order, what calls and blocks may change (`effects.ts`) | Evaluation-order facts, not checking-order facts; they feed initializer, return, and operation types, so they feed inference |
// | Which ways through branches and lazy operands can run, and the code that never runs (`WayFacts`, `DeadCode`, `projectEffects`) | Types, known values, condition tests, loop, call, and shared-write effects | Found by the check; the effects leave out what the previous check found never runs, up to `MAX_DEAD_CODE_ROUNDS` more checks |
// | Known values and their domains (`KnownValues`, `#initializers`) | Immutable initializers, the semantics' written sets, pure contracts, a bounded fold | Initializer links are found while identifiers are visited; the fold itself is order-free |
// | Runtime checks, form shapes, storage plans, speaker flow input (`TypeCheckResult`, `RuntimeCheckSite`) | The facts above, gathered by the last check as it visits each site | A guard is recorded when its source is visited and its plan is made at the end, with the types decided by then |

/**
 * The legacy type inference: the `TypeChecker` decides types while it checks, from the first value stored in a place
 * in checking order (ADR 0021 §1.6), and the project is checked again with what it found until a check finds nothing
 * new (see `checkWithEffects`), up to `MAX_STORAGE_ROUNDS` changes of the storage key types and `MAX_DEAD_CODE_ROUNDS`
 * changes of the code found never to run. The last check alone reports. The owner decided (O4, 2026-10-17) to
 * replace this inference by one that collects constraints, solves them once, and checks once; until then it is the
 * production backend and afterwards the oracle of the differential tests, and it is not improved.
 */
export const LEGACY_BACKEND: TypeAnalysisBackend = {
  name: "legacy",
  analyze({ files, options, onFile = () => {} }) {
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
      let facts: SolvedTypeFacts | undefined;
      return {
        checked: withVisibleOverflows(checked.result, programs, checked.known),
        facts: () =>
          (facts ??= legacyFacts(programs, checked.checker, checked.storage, checked.unchecked)),
      };
    }
  },
};

/** The type check of the project with the effects `effects`, and the code it found never runs (see `checkTypes`). */
function checkWithEffects(
  programs: readonly Program[],
  options: TypeCheckOptions,
  onFile: (file: number) => void,
  lines: LineNamer,
  effects: ProjectEffects,
): {
  readonly result: TypeCheckResult;
  readonly dead: DeadCode;
  readonly known: KnownValues;
  /** The checker that made the result, with the storage key types and unchecked properties it ended with. */
  readonly checker: TypeChecker;
  readonly storage: ReadonlyMap<string, StorageKeyType>;
  readonly unchecked: UncheckedProperties;
} {
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
        known: checker.knownValues,
        checker,
        storage,
        unchecked,
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
