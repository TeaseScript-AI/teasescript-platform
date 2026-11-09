import type {
  AssignmentStatement,
  BinaryExpression,
  CallExpression,
  Expression,
  Identifier,
  LetStatement,
  ListLiteral,
  LoadExpression,
  Program,
  PropertyAccessExpression,
  Statement,
} from "../../ast.js";
import { CONVERSIONS, isConversion, type Conversion } from "../../conversions.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "../../diagnostics.js";
import { isRepeatCount } from "../../loop-rules.js";
import { isRegex } from "../../runtime/values/value-predicates.js";
import {
  isTextMethod,
  stringLength,
  takesRegex,
  takesText,
  TEXT_METHODS,
  type DomainValue,
} from "../../text-operations.js";
import { literalRange } from "../../switch-cases.js";
import {
  repairedObject,
  type PartCheckPlan,
  type PartStep,
  type TypeCheckPlan,
  type TypePlan,
  type TypePropertyPlan,
} from "../../plan/model.js";
import { compileChild, runCompileTask, type CompileTask } from "../../compiler/continuation.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
  type SourceSpan,
} from "../../source.js";
import { isStaticDuration, KnownValues, type KnownValue } from "../../static-evaluation.js";
import { isCalendar } from "../../duration.js";
import { members, openType, union, UNKNOWN_TYPE, type StaticType } from "../../static-types.js";
import { typeFromAnnotation } from "../../static-types/annotations.js";
import { typeKey } from "../../storage-types.js";
import { typePlan } from "../../type-plans.js";
import {
  expressionParts,
  handlerBlocks,
  nestedStatements,
  statementExpressions,
} from "../../expression-children.js";
import { lazyDefaultArgument } from "../../lazy-defaults.js";
import { VALUE_KIND_NAMES, type ValueKind } from "../../value-kinds.js";
import { placeKey } from "../../way-facts.js";
import type {
  CoreRuntimeChecks,
  FactSite,
  RuntimeCheckSite,
  SolvedTypeFacts,
  TypeCheckResult,
} from "../backend.js";
import type { PlaceId, SourceSite, TypeTerm } from "../graph.js";
import {
  closedType,
  coreResult,
  type AdmittedType,
  type Answers,
  type ValueAnswer,
} from "./answers.js";
import { BudgetExhausted, joinSteps } from "./budget.js";
import {
  checkedType,
  COLLECTIONS,
  ContractDescriptors,
  levelProof,
  levelWalk,
  SLICE_DEPTH,
  SliceDepth,
  typeOfKinds,
  typeOfLevels,
  type ContractResult,
} from "./contract-descriptors.js";
import { typedDefault as defaultKinds } from "./contract.js";
import { leftOutCheck, leftOutCompletion, leftOutWarning } from "./consumers.js";
import { withoutEmpty } from "./exact-path.js";
import { otherwiseChains, provesNonNull, unusedFallbackRule } from "./consumers/otherwise.js";
import { literalRounds, literalTruth, type FlowNode } from "./flow-graph.js";
import { REASON, type Item, type ItemTag } from "./items.js";
import { propertyName, propertyStep, type CoreAnalysisRequest } from "./program.js";
import type { ReceivingObligation, ReceivingResult } from "./admission/receiving.js";
import {
  coreMessage,
  coreMessageInWords,
  messageSource,
  pathPhrase,
  staticCode,
  type MessageSource,
} from "./messages.js";
import {
  outcomeOf,
  type CheckedDiagnostic,
  type CoreDiagnostic,
  type CoreResult,
  type Obligation,
  type RequiredKind,
  type StaticDiagnostic,
  type StaticRule,
} from "./result.js";

/*
 * The consumer of the coarse core (the port plan's S5, completed in S9b): one walk over the source with the core's
 * answers, which makes what the compiler consumes, `TypeCheckResult`, and the facts the analysis settled on. Here for
 * the slice `CORE_BACKEND` accepts (`backend.ts`): the core's C1 and C2 diagnostics with their codes, the runtime checks
 * their obligations and C9's boundary checks owe, the ways and the code that never runs from the flow graph's literal
 * facts (P7), the known values, and the checks that owe the runtime nothing (`staticDiagnostics`). The slice has no
 * form, speaker property or storage key, so those outputs are empty.
 */

/** The store statement of the slice that brings an expression into its place. */
type Store = LetStatement | AssignmentStatement;

function siteKey(file: number, span: SourceSpan): string {
  return `${file}:${span.start.offset}:${span.end.offset}`;
}

function factSite(file: number, span: SourceSpan): FactSite {
  return { file, start: span.start.offset, end: span.end.offset };
}

/** An operand and the expressions it holds in parentheses, outermost first. */
function operands(expression: Expression): Expression[] {
  const found = [expression];
  for (let at = expression; at.kind === "parenthesizedExpression"; at = at.expression)
    found.push(at.expression);
  return found;
}

/** The source of a program inside the slice, walked once: its statements, its expressions and what each belongs to. */
export class SliceIndex {
  readonly lets: LetStatement[] = [];
  readonly statements: Statement[] = [];
  /** Every expression the analysis answers: all but an assignment's target. */
  readonly expressions: Expression[] = [];
  readonly lists: ListLiteral[] = [];
  /** The reads of variables and host values. */
  readonly reads: Identifier[] = [];
  /** The reads of a property, not as a store's target. */
  readonly properties: PropertyAccessExpression[] = [];
  /** The calls and loads, in source order. */
  readonly calls: CallExpression[] = [];
  readonly loads: LoadExpression[] = [];
  /** The values `say` shows. */
  readonly shown: Expression[] = [];
  /** The `otherwise`, call or load that each fallback or `default:` belongs to, by its operand and what it holds. */
  readonly #fallbackOf = new Map<Expression, BinaryExpression | CallExpression | LoadExpression>();
  /** The property store whose target's receiver each expression is. */
  readonly #storeOfReceiver = new Map<Expression, AssignmentStatement>();
  /** The `get` call whose index each expression is. */
  readonly #getOfIndex = new Map<Expression, CallExpression>();
  /** The expression each expression is an operand of, within its statement. */
  readonly #parent = new Map<Expression, Expression>();
  /** The name of the property each value of an object literal gives. */
  readonly #propertyOf = new Map<Expression, string>();
  /** Where each property name is first written, in a literal or as a store's target: its file and offset. */
  readonly #written = new Map<string, readonly [number, number]>();
  readonly #file = new Map<object, number>();
  readonly #bySite = new Map<string, Expression>();
  readonly #statementsBySite = new Map<string, Statement>();
  readonly #store = new Map<Expression, Store>();
  /** The expressions a store brings whole into its place: its value, and the elements of a list literal there. */
  readonly #whole = new Set<Expression>();
  readonly #role = new Map<Expression, "count" | "index">();
  /** The iterables of the `for` loops. */
  readonly #iterables = new Set<Expression>();

  /** `onFile` hears of each file as the walk enters it (S3 §6 keeps the request's progress callback). */
  public constructor(programs: readonly Program[], onFile: (file: number) => void = () => {}) {
    type Entry =
      | { readonly statement: Statement }
      | {
          readonly expression: Expression;
          readonly store: Store | null;
          readonly whole: boolean;
          readonly parent?: Expression | null;
        };
    programs.forEach((program, file) => {
      onFile(file);
      const pending: Entry[] = program.statements.map((statement) => ({ statement })).reverse();
      const statements = (list: readonly Statement[]): void => {
        for (let at = list.length - 1; at >= 0; at -= 1) pending.push({ statement: list[at]! });
      };
      for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
        if ("statement" in entry) {
          const statement = entry.statement;
          this.#file.set(statement, file);
          this.statements.push(statement);
          const key = siteKey(file, statement.span);
          if (!this.#statementsBySite.has(key)) this.#statementsBySite.set(key, statement);
          switch (statement.kind) {
            case "letStatement":
              this.lets.push(statement);
              pending.push({ expression: statement.initializer, store: statement, whole: true });
              break;
            case "assignmentStatement":
              pending.push({ expression: statement.value, store: statement, whole: true });
              // a property store reads its receiver, which a member check at the store reads (C5c)
              if (statement.target.kind === "propertyAccessExpression") {
                // C5 diagnostics name the whole target (§3.4); it is a store, so do not visit it as a read.
                this.#bySite.set(siteKey(file, statement.target.span), statement.target);
                this.#file.set(statement.target, file);
                this.#storeOfReceiver.set(statement.target, statement);
                this.#write(statement.target.property.name, file, statement.target.property.span);
                for (const held of operands(statement.target.object))
                  this.#storeOfReceiver.set(held, statement);
                pending.push({ expression: statement.target.object, store: null, whole: false });
              } else if (statement.target.kind === "indexExpression") {
                // an element store reads its receiver and its index
                pending.push({ expression: statement.target.index, store: null, whole: false });
                pending.push({ expression: statement.target.object, store: null, whole: false });
              }
              break;
            case "ifStatement":
              if (statement.elseBlock?.kind === "block") statements(statement.elseBlock.statements);
              else if (statement.elseBlock !== null)
                pending.push({ statement: statement.elseBlock });
              statements(statement.thenBlock.statements);
              pending.push({ expression: statement.condition, store: null, whole: false });
              break;
            case "repeatStatement":
              statements(statement.body.statements);
              this.#role.set(statement.count, "count");
              pending.push({ expression: statement.count, store: null, whole: false });
              break;
            case "sayStatement":
              this.shown.push(statement.value);
              pending.push({ expression: statement.value, store: null, whole: false });
              break;
            case "forStatement":
              this.#iterables.add(statement.iterable);
              statements(statement.body.statements);
              pending.push({ expression: statement.iterable, store: null, whole: false });
              break;
            default: {
              // any other statement (outside the candidate's slice, `backend.ts`): its blocks and its own expressions
              // in source order, so the checks that read every expression find them (a record of any program)
              const nested = [
                ...nestedStatements(statement),
                ...(statement.kind === "functionDeclaration" ? statement.body.statements : []),
                ...handlerBlocks(statement).flatMap((block) => block.statements),
              ];
              statements(nested.sort((a, b) => a.span.start.offset - b.span.start.offset));
              const own = [
                ...(statement.kind === "globalStatement" && statement.assignment === null
                  ? [statement.initial]
                  : []),
                ...(statement.kind === "functionDeclaration"
                  ? statement.parameters.flatMap((parameter) =>
                      parameter.defaultValue === null ? [] : [parameter.defaultValue],
                    )
                  : []),
                ...statementExpressions(statement),
              ];
              for (let at = own.length - 1; at >= 0; at -= 1)
                pending.push({ expression: own[at]!, store: null, whole: false });
            }
          }
          continue;
        }
        const { expression, store, whole } = entry;
        if ("parent" in entry && entry.parent !== null) this.#parent.set(expression, entry.parent);
        this.#file.set(expression, file);
        this.expressions.push(expression);
        const key = siteKey(file, expression.span);
        if (!this.#bySite.has(key)) this.#bySite.set(key, expression);
        if (store !== null) this.#store.set(expression, store);
        if (whole) this.#whole.add(expression);
        switch (expression.kind) {
          case "identifier":
            this.reads.push(expression);
            break;
          case "listLiteral":
            this.lists.push(expression);
            for (let at = expression.elements.length - 1; at >= 0; at -= 1)
              pending.push({
                expression: expression.elements[at]!,
                store,
                whole,
                parent: expression,
              });
            break;
          case "indexExpression":
            this.#role.set(expression.index, "index");
            pending.push({ expression: expression.index, store, whole: false, parent: expression });
            pending.push({
              expression: expression.object,
              store,
              whole: false,
              parent: expression,
            });
            break;
          case "parenthesizedExpression": {
            // a count or an index in parentheses: its content is where the core's diagnostic stands (§3.4)
            const role = this.#role.get(expression);
            if (role !== undefined) this.#role.set(expression.expression, role);
            pending.push({ expression: expression.expression, store, whole, parent: expression });
            break;
          }
          case "objectLiteral":
            for (let at = expression.properties.length - 1; at >= 0; at -= 1) {
              const property = expression.properties[at]!;
              this.#propertyOf.set(property.value, property.name.name);
              this.#write(property.name.name, file, property.name.span);
              pending.push({ expression: property.value, store, whole, parent: expression });
            }
            break;
          case "propertyAccessExpression":
            this.properties.push(expression);
            pending.push({
              expression: expression.object,
              store,
              whole: false,
              parent: expression,
            });
            break;
          case "binaryExpression":
            // `otherwise`, the slice's one operator with a fallback
            if (expression.operator === "otherwise")
              for (const held of operands(expression.right)) this.#fallbackOf.set(held, expression);
            pending.push({ expression: expression.right, store, whole: false, parent: expression });
            pending.push({ expression: expression.left, store, whole: false, parent: expression });
            break;
          case "callExpression": {
            this.calls.push(expression);
            for (const argument of expression.arguments)
              if (argument.kind === "namedArgument" && argument.name.name === "default")
                for (const held of operands(argument.value)) this.#fallbackOf.set(held, expression);
            const method =
              expression.callee.kind === "propertyAccessExpression" ? expression.callee : null;
            const index = expression.arguments[0];
            if (method?.property.name === "get" && index?.kind === "positionalArgument") {
              this.#role.set(index.value, "index");
              for (const held of operands(index.value)) this.#getOfIndex.set(held, expression);
            }
            for (let at = expression.arguments.length - 1; at >= 0; at -= 1)
              pending.push({
                expression: expression.arguments[at]!.value,
                store,
                whole: false,
                parent: expression,
              });
            if (method !== null)
              pending.push({ expression: method.object, store, whole: false, parent: expression });
            break;
          }
          default: {
            // any other expression (outside the slice): its parts, then the statements of the handlers it registers
            for (const block of handlerBlocks(expression)) statements(block.statements);
            const parts = expressionParts(expression);
            for (let at = parts.length - 1; at >= 0; at -= 1)
              pending.push({ expression: parts[at]!, store, whole: false, parent: expression });
            break;
          }
          case "loadExpression":
            this.loads.push(expression);
            if (expression.defaultValue !== null) {
              for (const held of operands(expression.defaultValue))
                this.#fallbackOf.set(held, expression);
              pending.push({
                expression: expression.defaultValue,
                store,
                whole: false,
                parent: expression,
              });
            }
            pending.push({ expression: expression.key, store, whole: false, parent: expression });
            break;
        }
      }
    });
  }

  public fileOf(node: Statement | Expression): number {
    const file = this.#file.get(node);
    if (file === undefined) throw new Error(`The slice's source has no ${node.kind} there.`);
    return file;
  }

  /** The expression at a site of the analysis. */
  public expressionAt(site: SourceSite): Expression {
    const found = this.findExpressionAt(site);
    if (found === undefined)
      throw new Error(`The slice's source has no expression at ${site.file}:${site.start}.`);
    return found;
  }

  /** The expression at a site, if the slice's source has one. */
  public findExpressionAt(site: SourceSite): Expression | undefined {
    return this.#bySite.get(`${site.file}:${site.start}:${site.end}`);
  }

  /** The `let` or assignment whose stored value holds `expression`, if any. */
  public storeOf(expression: Expression): Store | undefined {
    return this.#store.get(expression);
  }

  /** The `let` or assignment a site names: the statement itself, or the one whose stored value holds the expression. */
  public storeAt(site: SourceSite): Store | undefined {
    const key = `${site.file}:${site.start}:${site.end}`;
    const statement = this.#statementsBySite.get(key);
    if (statement?.kind === "letStatement" || statement?.kind === "assignmentStatement")
      return statement;
    const expression = this.#bySite.get(key);
    return expression === undefined ? undefined : this.#store.get(expression);
  }

  /** The span of the expression or statement at a site of the analysis. */
  public spanAt(site: SourceSite): SourceSpan {
    const key = `${site.file}:${site.start}:${site.end}`;
    const found = this.#bySite.get(key) ?? this.#statementsBySite.get(key);
    if (found === undefined)
      throw new Error(`The slice's source has nothing at ${site.file}:${site.start}.`);
    return found.span;
  }

  /** Whether a store brings `expression` whole into its place (not as an operand of an index read). */
  public storedWhole(expression: Expression): boolean {
    return this.#whole.has(expression);
  }

  /** Whether `expression` is a `for` loop's iterable. */
  public iterates(expression: Expression): boolean {
    return this.#iterables.has(expression);
  }

  /** Whether `expression` is a `repeat` count or an index. */
  public roleOf(expression: Expression): "count" | "index" | undefined {
    return this.#role.get(expression);
  }

  /** The `otherwise` whose fallback, or the call or load whose `default:`, `expression` is or holds in parentheses. */
  public fallbackOf(
    expression: Expression,
  ): BinaryExpression | CallExpression | LoadExpression | undefined {
    return this.#fallbackOf.get(expression);
  }

  /** The property store whose whole target or receiver `expression` is, or holds in parentheses. */
  public storeOfReceiver(expression: Expression): AssignmentStatement | undefined {
    return this.#storeOfReceiver.get(expression);
  }

  /** The `get` call whose index `expression` is, or holds in parentheses. */
  public getOfIndex(expression: Expression): CallExpression | undefined {
    return this.#getOfIndex.get(expression);
  }

  /** The expression `expression` is an operand of, or `undefined` for a statement's own expression. */
  public parentOf(expression: Expression): Expression | undefined {
    return this.#parent.get(expression);
  }

  #write(name: string, file: number, span: SourceSpan): void {
    const known = this.#written.get(name);
    if (
      known === undefined ||
      file < known[0] ||
      (file === known[0] && span.start.offset < known[1])
    )
      this.#written.set(name, [file, span.start.offset]);
  }

  /** Property names in the order the program first writes them, in a literal or as a store's target, then by name. */
  public inWrittenOrder(names: Iterable<string>): string[] {
    const at = (name: string): readonly [number, number] =>
      this.#written.get(name) ?? [Infinity, Infinity];
    const compare = <T>(a: T, b: T): number => (a === b ? 0 : a < b ? -1 : 1);
    return [...names]
      .map((name) => ({ name, key: at(name) }))
      .sort(
        (a, b) =>
          compare(a.key[0], b.key[0]) || compare(a.key[1], b.key[1]) || compare(a.name, b.name),
      )
      .map(({ name }) => name);
  }

  /** The name of the property whose value `expression` is in an object literal, or `undefined`. */
  public propertyOf(expression: Expression): string | undefined {
    return this.#propertyOf.get(expression);
  }

  public site(node: Statement | Expression): SourceSite {
    return { file: this.fileOf(node), start: node.span.start.offset, end: node.span.end.offset };
  }
}

/**
 * The flow graph's node of a statement or an expression of the slice: an `if`'s is its condition's, a `repeat`'s its
 * count's and a `for`'s its iterable's, which run first; parentheses have their content's, whose value they are (S3 §3.4: a consumer's site is the
 * expression inside them).
 */
export function nodeOf(
  answers: Answers,
  index: SliceIndex,
  node: Statement | Expression,
): FlowNode {
  let current: Statement | Expression = node;
  for (;;)
    if (current.kind === "ifStatement") current = current.condition;
    else if (current.kind === "repeatStatement") current = current.count;
    else if (current.kind === "forStatement") current = current.iterable;
    else if (current.kind === "expressionStatement") current = current.expression;
    else if (current.kind === "parenthesizedExpression") current = current.expression;
    else break;
  const site = index.site(current);
  const found = current.kind.endsWith("Statement")
    ? answers.graph.statementAt(site)
    : answers.graph.expressionAt(site);
  if (found === undefined) throw new Error(`The flow graph has no node for this ${current.kind}.`);
  return found;
}

/** The `let` that declares each variable of the slice, by its place. */
function declarations(answers: Answers, index: SliceIndex): Map<PlaceId, LetStatement> {
  const found = new Map<PlaceId, LetStatement>();
  for (const statement of index.lets) {
    const place = answers.at(nodeOf(answers, index, statement))?.place;
    if (place !== null && place !== undefined) found.set(place.id, statement);
  }
  return found;
}

/** The variable a store writes: its declaration, through the place the analysis reads at the store. */
function declarationOf(
  answers: Answers,
  index: SliceIndex,
  lets: ReadonlyMap<PlaceId, LetStatement>,
  store: Store,
): LetStatement {
  if (store.kind === "letStatement") return store;
  const place = answers.at(nodeOf(answers, index, store))?.place;
  const declaration = place === null || place === undefined ? undefined : lets.get(place.id);
  if (declaration === undefined)
    throw new Error("An assignment of the slice stores into no variable.");
  return declaration;
}

/** Whether each core diagnostic a compile reports carries its message in words too (`withMessagesInWords`). */
let messagesInWords = false;

/**
 * Test-only: runs `callback` with each core diagnostic a compile inside it reports carrying `words`, its message with every
 * fix in words (`coreMessageInWords`), which the stop oracle compares with a stop's (#1449).
 */
export function withMessagesInWords<T>(callback: () => T): T {
  if (messagesInWords) throw new Error("Messages in words are already on.");
  messagesInWords = true;
  try {
    return callback();
  } finally {
    messagesInWords = false;
  }
}

/**
 * A diagnostic of the core as the compiler reports it: its rule's code (D3 (a)), the severity of its class ("not
 * checked (budget)" at the editor's information level), its sentences (`messages.ts`, D1) and its site's
 * span (D2); under `withMessagesInWords` also its message in words. `moved` is the plan's checks a stop moved to the
 * runtime (`movedChecks`), which the stop's warning counts.
 */
function diagnosticOf(
  diagnostic: CheckedDiagnostic,
  source: MessageSource,
  moved: number,
): Diagnostic {
  const shown = createDiagnostic(
    diagnostic.class === "compile-error"
      ? DiagnosticSeverity.Error
      : diagnostic.class === "not-checked-budget"
        ? DiagnosticSeverity.Info
        : DiagnosticSeverity.Warning,
    diagnostic.code,
    coreMessage(diagnostic, source, moved),
    createSourceSpan(
      positionAt(source, diagnostic.site.file, diagnostic.site.start),
      positionAt(source, diagnostic.site.file, diagnostic.site.end),
    ),
  );
  return messagesInWords
    ? Object.freeze({ ...shown, words: coreMessageInWords(diagnostic, source, moved) })
    : shown;
}

/** A source position at an offset of a file, its line and column from the source's line index (each file's once). */
function positionAt(source: MessageSource, file: number, offset: number): SourcePosition {
  const site = { file, start: offset, end: offset };
  return createSourcePosition(offset, source.line(site) - 1, source.column(site));
}

/** What the compiler consumes of the analysis of a program inside the slice. */
export function coreCheckResult(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): TypeCheckResult {
  const diagnostics: Diagnostic[][] = request.files.map(() => []);
  const { checks, core, contracts, moved } = runtimeChecks(answers, index, request);
  const known = knownValues(answers, index, (call) => core.expected.get(call));
  const fallbacks = fallbackUses(answers, index);
  const result = checkedOf(answers, index, known, fallbacks);
  // (a program the analysis rejects has no plan to let a value through: nothing to decline)
  if (!result.diagnostics.some((diagnostic) => diagnostic.class === "compile-error"))
    lostCheck(answers, index, contracts, checks, core);
  const source = messageSource(
    request.files.map((file) => file.source),
    result.diagnostics,
    (base) => answers.keptName(base),
    (units) => answers.messageWork(units),
  );
  const shown = new Set(reportedDiagnostics(answers, result.diagnostics));
  for (const diagnostic of result.diagnostics)
    if (shown.has(diagnostic))
      diagnostics[diagnostic.site.file]!.push(diagnosticOf(diagnostic, source, moved));
  const paths = new Map<Statement, readonly boolean[]>();
  for (const statement of index.statements)
    if (statement.kind === "ifStatement") {
      // P7: a literal condition takes one branch (the flow graph's own rule)
      const truth = literalTruth(statement.condition);
      paths.set(statement, [truth !== false, truth !== true]);
    } else if (statement.kind === "repeatStatement") {
      // P7: whether the body runs, and whether it may run not at all
      const rounds = literalRounds(statement.count);
      paths.set(statement, rounds === null ? [true, true] : [rounds !== "none", rounds === "none"]);
    }
  // by site, so a file's order does not follow the core's consumer order (a receiver's and a member's warnings start alike)
  for (const list of diagnostics)
    list.sort(
      (a, b) =>
        a.span.start.offset - b.span.start.offset ||
        a.span.end.offset - b.span.end.offset ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
    );
  return {
    diagnostics,
    runtimeChecks: checks,
    coreChecks: core,
    formShapes: new Map(),
    ways: { paths, operands: operandWays(index, fallbacks) },
    unreachable: unreachable(answers, index),
    speakerFlow: { reads: new Map(), stores: new Map() },
    storageTypes: [],
    known,
  };
}

/**
 * The known values of a program (S3 §2, group V): the one constant service, handed to the answers so that a view's
 * known value is the consumer's; a `fromJson` reads its JSON as `expected` gives its type, so its known
 * value is the one the run gets.
 */
function knownValues(
  answers: Answers,
  index: SliceIndex,
  expected: (call: CallExpression) => TypePlan | undefined,
): (expression: Expression) => KnownValue | undefined {
  const values = new KnownValues(
    (identifier) => {
      const initializer = answers.initializers.get(
        siteKey(index.fileOf(identifier), identifier.span),
      );
      return initializer === undefined ? undefined : index.expressionAt(initializer);
    },
    expected,
    // (the branch's narrowing at each read the walk evaluates, an operand's included, #1073 PR 2: where it admits no
    // kind of the value, as `n` under `if n is integer` with `n = 1.5`, the read never runs with it, so a dead branch is
    // no static error; constant work per read, inside the walk's own iteration, Codex r1 and r2 on #1884)
    (identifier, value) => {
      const node = answers.graph.expressionAt(index.site(identifier));
      const read = node === undefined ? undefined : answers.at(node);
      if (read === undefined || read === null) return true;
      const kinds = withoutEmpty(read.items).map((item) => item.tag);
      return kinds.includes("unknown") || admitsKnown(kinds, value);
    },
  );
  const known = (expression: Expression) => values.known(expression);
  answers.shareKnown(known);
  return known;
}

/**
 * Whether a read's kinds admit a known scalar: `null`, text, a boolean, a whole number as an `integer` or a `number`, a
 * fraction as a `number`.
 */
function admitsKnown(kinds: readonly string[], value: KnownValue): boolean {
  if (value === null) return kinds.includes("null");
  if (typeof value === "number")
    return kinds.includes("number") || (Number.isInteger(value) && kinds.includes("integer"));
  if (typeof value === "string") return kinds.includes("string");
  if (typeof value === "boolean") return kinds.includes("boolean");
  // (a structured value: its kinds are not decided here, so it keeps its known value)
  return true;
}

/**
 * The core's result with the checks that owe the runtime nothing (`StaticDiagnostic`, the lead's decision 3 on #1072):
 * the one list of diagnostics its record (`coreRecord`) and the compiler's diagnostics are both made from.
 */
function checkedOf(
  answers: Answers,
  index: SliceIndex,
  known: (expression: Expression) => KnownValue | undefined,
  fallbacks: FallbackUses,
): CoreResult {
  // (each in the analysis's site order, before the first diagnostic of a later site: a record's lists are in source
  // order)
  const found = staticDiagnostics(answers, index, known, fallbacks).sort((a, b) =>
    siteOrder(a.site, b.site),
  );
  // (a known calendar offset is one problem with one diagnostic, the runtime's sentence: the analysis's own warning of
  // the operation at that site, a hedge beside it, goes, decision 6)
  const at = (site: SourceSite): string => `${site.file}:${site.start}:${site.end}`;
  const offsets = new Set(
    found.filter((d) => d.rule.rule === "calendar-offset").map((d) => at(d.site)),
  );
  const analysed = answers.diagnostics.filter(
    (d) =>
      !(d.class === "warning-runtime-check" && d.kind === "operator" && offsets.has(at(d.site))),
  );
  const diagnostics: CheckedDiagnostic[] = [];
  let next = 0;
  for (const diagnostic of analysed) {
    while (next < found.length && siteOrder(found[next]!.site, diagnostic.site) < 0)
      diagnostics.push(found[next++]!);
    diagnostics.push(diagnostic);
  }
  diagnostics.push(...found.slice(next));
  return { outcome: outcomeOf(diagnostics), diagnostics, checks: coreResult(answers).checks };
}

/**
 * V30 §18 (#1072): each chain of `otherwise` with the first link whose left side is never `null` (`provesNonNull` of
 * the core's answer at that read, through the one read route, `Answers.at`), `null` for none: the one decision the
 * warning that its fallbacks are never used (TSV062) and the ways the plan's checks follow (`operandWays`) both read,
 * made once. A link's left side is read only while no earlier link proved its own: a chain is decided at its first.
 */
type FallbackUses = readonly {
  readonly chain: readonly BinaryExpression[];
  readonly first: number | null;
}[];

function fallbackUses(answers: Answers, index: SliceIndex): FallbackUses {
  return otherwiseChains(index.expressions)
    .map((chain) => ({
      chain,
      first: chain.findIndex((link) =>
        provesNonNull(answers.at(nodeOf(answers, index, link.left))?.items ?? null),
      ),
    }))
    .map(({ chain, first }) => ({ chain, first: first < 0 ? null : first }));
}

/**
 * The ways of each `otherwise` the plan's checks follow (`WayFacts.operands`), from the one decision (`fallbackUses`):
 * from a chain's first link whose left side is never `null` on, the fallback never runs and the value is always kept.
 */
function operandWays(index: SliceIndex, fallbacks: FallbackUses): Map<string, readonly boolean[]> {
  const ways = new Map<string, readonly boolean[]>();
  for (const { chain, first } of fallbacks)
    if (first !== null)
      for (const link of chain.slice(first))
        ways.set(placeKey(index.fileOf(link), link.span), [false, true]);
  return ways;
}

/** Two sites in source order: by file, start and end. */
function siteOrder(a: SourceSite, b: SourceSite): number {
  return a.file - b.file || a.start - b.start || a.end - b.end;
}

/**
 * What `ask` makes of a finished analysis's answers, its questions spending the analysis's allowance: one past
 * it stops there, the finished analysis's findings and decisions standing, and what is asked from then on answers
 * `STOPPED` (D4 a′). Where nothing stopped, the receiving completion runs then, after everything that can stop, and
 * asks again with its completed contracts within its own allowance (`Answers.completed`, #1526 phase C); where it keeps
 * no result, what was asked first stands, asked once more as finishing work where obligations were left without results,
 * so that the publication's gate reads them and may decline the program (#1526 decision 2). The backend's outcome and
 * the test-only checked result (`checkedResult`) both ask so.
 */
export function asked<T>(answers: Answers, ask: (answers: Answers) => T): T {
  let first: T;
  try {
    first = ask(answers);
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    return ask(answers.stoppedAt(error.limit));
  }
  // (a test that leaves the completion's checks out leaves the completion out: phase B's answers)
  if (leftOutCompletion()) return first;
  const again = answers.completed(() => ask(answers));
  if (again !== null) return again;
  // (#1526 decision 2, condition 1: a completion that kept no result, past its allowance even before it found its
  // obligations, leaves the settled pass's publication, which was asked before the registry was made; asked once more
  // apart, its gate reads the obligations left without results)
  return (answers.budget.closure?.counts.capped ?? 0) > 0 ||
    answers.receiving.some(({ result }) => result === null)
    ? answers.apart(() => ask(answers))
    : first;
}

/**
 * Test-only: the core's result for a request, with its checks that owe the runtime nothing, as the compiler reads it
 * (`checkedOf`, `asked`), also for a program outside the candidate's slice: a typed parse the slice does not follow
 * there reads its JSON without its expected type.
 */
export function checkedResult(answers: Answers, request: CoreAnalysisRequest): CoreResult {
  const index = new SliceIndex(request.files.map((file) => file.program));
  return asked(answers, (answers) => {
    let contracts: Contracts | null = null;
    const expected = (call: CallExpression): TypePlan | undefined => {
      contracts ??= new Contracts(answers, index, declarations(answers, index));
      try {
        return contracts.expected(call) ?? undefined;
      } catch (error) {
        if (error instanceof OutsideContract) return undefined;
        throw error;
      }
    };
    return checkedOf(
      answers,
      index,
      knownValues(answers, index, expected),
      fallbackUses(answers, index),
    );
  });
}

/**
 * The checks of known values that owe the runtime nothing (S3 §2, group V), each where the core finds its value's kinds
 * fine (no diagnostic of the analysis at its site): a `repeat` count's known value outside its domain (`loop-rules.ts`),
 * a conversion of known text it cannot convert (V30 §13, #1105), and a written range that holds no number (V30 §6, an
 * ordinary warning).
 */
function staticDiagnostics(
  answers: Answers,
  index: SliceIndex,
  known: (expression: Expression) => KnownValue | undefined,
  fallbacks: FallbackUses,
): StaticDiagnostic[] {
  const sited = new Set<string>();
  for (const diagnostic of answers.diagnostics)
    if (diagnostic.kind !== "budget")
      sited.add(`${diagnostic.site.file}:${diagnostic.site.start}:${diagnostic.site.end}`);
  const found: StaticDiagnostic[] = [];
  const report = (site: SourceSite, rule: StaticRule): void => {
    found.push({ class: "compile-error", kind: "static", code: staticCode(rule), site, rule });
  };
  for (const statement of index.statements)
    if (statement.kind === "repeatStatement") {
      const count = unwrap(statement.count);
      if (sited.has(siteKey(index.fileOf(statement), count.span))) continue;
      const value = known(statement.count);
      if (typeof value === "number" && !isRepeatCount(value))
        report(index.site(statement.count), { rule: "repeat-count", value });
    }
  for (const call of index.calls) {
    const conversion = knownConversionError(answers, index, call);
    if (conversion !== null) report(index.site(conversion.value), conversion.rule);
    // (an argument the analysis found a problem with is not read: its own diagnostic stands)
    const diagnosed = (argument: Expression): boolean =>
      sited.has(siteKey(index.fileOf(argument), unwrap(argument).span));
    for (const found of knownTextArguments(answers, index, call, known, diagnosed))
      report(index.site(found.at), { rule: "text-argument", message: found.message });
  }
  // V30 §18 (#1072): a chain's fallbacks from its first link whose left side is never `null` on never run, an ordinary
  // warning with no runtime check, from the one decision (`fallbackUses`); they stay checked (ADR 0021 1.8)
  for (const { chain, first } of fallbacks) {
    if (first === null) continue;
    const link = chain[first]!;
    found.push({
      class: "warning",
      kind: "static",
      code: "TSV062",
      site: {
        file: index.fileOf(link),
        start: link.operatorSpan.start.offset,
        end: chain.at(-1)!.span.end.offset,
      },
      rule: unusedFallbackRule(chain, first, (object) => {
        const kinds = withoutEmpty(answers.at(nodeOf(answers, index, object))?.items ?? []);
        return kinds.length > 0 && kinds.every((item) => item.tag === "list")
          ? "list"
          : kinds.length > 0 && kinds.every((item) => item.tag === "dict")
            ? "dict"
            : null;
      }),
    });
  }
  // V30 §6: a written range that holds no number, an ordinary warning where a loop or `toList()` reads it
  const empty = (range: Expression, use: "loop" | "list"): void => {
    const bounds = literalRange(range);
    if (
      bounds === undefined ||
      ![bounds.startText, bounds.endText].every((text) => /^-?\d+$/.test(text)) ||
      (bounds.inclusive ? bounds.end >= bounds.start : bounds.end > bounds.start)
    )
      return;
    found.push({
      class: "warning",
      kind: "static",
      code: "TSV046",
      site: index.site(range),
      rule: {
        rule: "empty-range",
        use,
        start: bounds.startText,
        end: bounds.endText,
        inclusive: bounds.inclusive,
      },
    });
  };
  // ADR 0026 §5, decision 6 on #1072: a date or a local date and time moved by a known calendar duration with an exact
  // offset, beside the operation's own check (F16), the binary form at its operation and the compound one at its statement
  const offset = (target: readonly ItemTag[], operand: Expression, site: SourceSite): void => {
    const kinds = target.filter((tag) => tag !== "empty");
    const moved =
      kinds.length > 0 && kinds.every((tag) => tag === "date")
        ? "date"
        : kinds.length > 0 && kinds.every((tag) => tag === "datetime")
          ? "datetime"
          : null;
    const value = known(operand);
    if (
      moved === null ||
      !isStaticDuration(value) ||
      !isCalendar(value) ||
      value.milliseconds === 0
    )
      return;
    report(site, { rule: "calendar-offset", target: moved, duration: value });
  };
  for (const expression of index.expressions)
    if (
      expression.kind === "binaryExpression" &&
      (expression.operator === "+" || expression.operator === "-")
    )
      offset(
        (answers.at(nodeOf(answers, index, expression.left))?.items ?? []).map((item) => item.tag),
        expression.right,
        index.site(expression),
      );
  for (const statement of index.statements)
    if (statement.kind === "assignmentStatement" && statement.operator !== "=") {
      // (the target's current value, read before the operand as the compound operation reads it, `collector.ts`: a
      // variable's read, or its root's value below its properties and elements)
      const file = index.fileOf(statement);
      const steps: string[] = [];
      let root: Expression = statement.target;
      for (;;)
        if (root.kind === "propertyAccessExpression") {
          steps.unshift(propertyStep(root.property.name));
          root = root.object;
        } else if (root.kind === "indexExpression") {
          steps.unshift("element");
          root = root.object;
        } else if (root.kind === "parenthesizedExpression") root = root.expression;
        else break;
      const read = answers.graph.expressionAt({
        file,
        start: root.span.start.offset,
        end: root.span.end.offset,
      });
      if (read !== undefined)
        offset(
          answers.valueAt(read, steps).items.map((item) => item.tag),
          statement.value,
          index.site(statement),
        );
    }
  for (const statement of index.statements)
    if (statement.kind === "forStatement") empty(statement.iterable, "loop");
  for (const call of index.calls)
    if (call.callee.kind === "propertyAccessExpression" && call.callee.property.name === "toList")
      empty(call.callee.object, "list");
  return found;
}

/**
 * V30 §8 (#1701): "a visibly negative, out-of-range, or empty argument" of a method of text is a compile error. Each
 * argument domain of the method (`TextDomain`) whose values are all known, the receiver's text where it reads its
 * length, is checked in the method's order with the runtime's sentence, and reported at the last argument it reads (its
 * content, inside parentheses, §3.4); an argument the analysis or an earlier domain found a problem with is not read,
 * as the current checker does (`operation-checks.ts`). Every argument positional, and the receiver text as the core
 * answers it or as the place it reads is admitted (the invariant below).
 */
function knownTextArguments(
  answers: Answers,
  index: SliceIndex,
  call: CallExpression,
  known: (expression: Expression) => KnownValue | undefined,
  diagnosed: (argument: Expression) => boolean,
): { readonly at: Expression; readonly message: string }[] {
  const callee = call.callee;
  if (callee.kind !== "propertyAccessExpression" || !isTextMethod(callee.property.name)) return [];
  const method = TEXT_METHODS[callee.property.name];
  if (
    call.arguments.length > method.parameters.length ||
    call.arguments.some((argument) => argument.kind !== "positionalArgument")
  )
    return [];
  const receiver = answers.at(nodeOf(answers, index, callee.object));
  if (receiver === null) return [];
  // (the invariant: a method's argument domains apply only where the receiver is answered text, or the place it reads
  // is admitted text, `empty`, an element read's own concern, ignored; nothing else, so a receiver that may be null or
  // of another kind keeps its own check first, and one that only a fallback or a call proves text is #1727's)
  const text = (kinds: readonly ItemTag[]): boolean => {
    const present = kinds.filter((tag) => tag !== "empty");
    return present.length > 0 && present.every((tag) => tag === "string");
  };
  const admitted =
    receiver.place === null ? null : answers.place(receiver.place.id, receiver.place.path).admitted;
  if (
    !text(receiver.items.map((item) => item.tag)) &&
    !(admitted !== null && "kinds" in admitted && text(admitted.kinds))
  )
    return [];
  const receiverText = known(callee.object);
  const values: (DomainValue | undefined | null)[] = call.arguments.map((argument, position) => {
    if (diagnosed(argument.value)) return null;
    const parameter = method.parameters[position]!;
    const value = known(argument.value);
    if (!takesText(parameter) && !takesRegex(parameter))
      return typeof value === "number" ? value : undefined;
    return (takesText(parameter) && typeof value === "string") ||
      (takesRegex(parameter) && value !== undefined && isRegex(value))
      ? value
      : undefined;
  });
  const found: { at: Expression; message: string }[] = [];
  for (const domain of method.domains) {
    const read: DomainValue[] = [];
    for (const position of domain.reads) {
      const value =
        position === "length"
          ? typeof receiverText === "string"
            ? stringLength(receiverText)
            : undefined
          : values[position];
      if (value === undefined || value === null) break;
      read.push(value);
    }
    if (read.length !== domain.reads.length) continue;
    const message = domain.problem(read, method);
    if (message === undefined) continue;
    for (const position of domain.reads) if (position !== "length") values[position] = null;
    const last = Math.max(
      ...domain.reads.map((position) => (position === "length" ? -1 : position)),
    );
    found.push({ at: unwrap(call.arguments[last]!.value), message });
  }
  return found;
}

/**
 * V30 §13: a conversion of a value the compiler knows and the conversion cannot convert is a compile error, also with a
 * `default:` (#1105). The value is the argument's known value through its view, never the call's, which the default
 * would give. A value of a type the conversion does not take, and the parts of `toDateTime(date, time)`, are the
 * built-in signature check's (C13, S9b); the conversions of text keep their fallback for content they cannot read.
 */
function knownConversionError(
  answers: Answers,
  index: SliceIndex,
  call: CallExpression,
): { readonly value: Expression; readonly rule: StaticRule } | null {
  if (call.callee.kind !== "identifier" || !isConversion(call.callee.name)) return null;
  const name = call.callee.name;
  const conversion: Conversion = CONVERSIONS[name];
  const positional = call.arguments.filter((argument) => argument.kind === "positionalArgument");
  if (
    conversion.takes !== "value" ||
    positional.length !== 1 ||
    call.arguments.some(
      (argument) => argument.kind === "namedArgument" && argument.name.name !== "default",
    )
  )
    return null;
  const value = positional[0]!.value;
  const text = answers.view(nodeOf(answers, index, value)).known;
  return typeof text === "string" && conversion.textProblem(text) !== undefined
    ? { value, rule: { rule: "conversion", conversion: name, text } }
    : null;
}

/** A site of the plan's checks: a store or load, a list `get` call, or the owner of a selected fallback. */
type CheckSite = RuntimeCheckSite | BinaryExpression;

/**
 * Who owes each site's check (#2081): a published warning or a boundary, or only warnings a stop deferred, which the
 * stop's warning counts (`movedChecks`).
 */
interface Owers {
  readonly published: Set<CheckSite>;
  readonly stopped: Set<CheckSite>;
}

/** A selected fallback's checks (C10): the fallback and each depth its obligations name. */
interface Selected {
  readonly fallback: Expression;
  readonly depths: FallbackDepth[];
}

/** An obligation owed at its store, with the kinds its rule names and who owes it. */
interface Owed {
  readonly obligation: Obligation;
  readonly kinds: readonly ItemTag[] | null;
  readonly by: Set<CheckSite>;
}

/**
 * The checks the warnings owe (`runtimeChecks`), the published warnings' and then those a stop moved to the runtime:
 * C1's obligations, each placed at its store later, with the kinds its rule names, a stopped analysis's store type
 * where it decided none (D4 a′); C10's fallbacks by owner; C5c's stores and C2's calls, into `core`. Each site's owers
 * are marked as it is reached (`owers`).
 */
function warningChecks(
  answers: Answers,
  index: SliceIndex,
  core: {
    readonly requireExisting: Set<AssignmentStatement>;
    readonly indexChecks: Set<CallExpression>;
  },
  owers: Owers,
): { owed: Owed[]; fallbacks: Map<BinaryExpression | CallExpression, Selected> } {
  const owed: Owed[] = [];
  const fallbacks = new Map<BinaryExpression | CallExpression, Selected>();
  // (in this order: the published warnings', then the stop's)
  for (const [diagnostics, by] of [
    [answers.diagnostics, owers.published],
    [answers.budget.deferred, owers.stopped],
  ] as const)
    for (const diagnostic of diagnostics) {
      if (diagnostic.class !== "warning-runtime-check" || diagnostic.kind === "budget") continue;
      if (leftOutWarning(diagnostic)) continue;
      const expression = index.expressionAt(diagnostic.site);
      switch (diagnostic.kind) {
        case "written-target": {
          // C10's obligation names the fallback as every obligation names its value (§10.5 r4.10: `xs.element` for
          // `xs[0]`, `d.entry` for a dict's, its text where no place holds it), with the element steps of a nested
          // literal's depth; C1's a place (S6's departure 6)
          const held = index.fallbackOf(expression);
          const steps =
            held === undefined
              ? null
              : fallbackSteps(
                  diagnostic.obligation.target,
                  answers.targetName(nodeOf(answers, index, expression)),
                );
          const owner = steps === null ? undefined : held;
          if (owner === undefined)
            owed.push({
              obligation: diagnostic.obligation,
              kinds: diagnostic.rule.rule === "store" ? diagnostic.rule.type : null,
              by,
            });
          // C10: a load's default is checked as the load's result; any other where it is selected, all its depths at
          // once
          else if (owner.kind !== "loadExpression") {
            const found = fallbacks.get(owner) ?? { fallback: expression, depths: [] };
            found.depths.push({ steps: steps!, against: diagnostic.obligation.against });
            fallbacks.set(owner, found);
            by.add(owner);
          }
          break;
        }
        case "member-read": {
          // C5c: a store whose receiver may lack the property, or not be an object, needs it there
          const store = index.storeOfReceiver(expression);
          if (store !== undefined) {
            core.requireExisting.add(store);
            by.add(store);
          }
          break;
        }
        case "integer-use": {
          // C2: a list `get` checks its index's kind; a count or an index read is the runtime's own check
          const call = index.getOfIndex(expression);
          if (call !== undefined) {
            core.indexChecks.add(call);
            by.add(call);
          }
          break;
        }
        case "operator":
          break;
      }
    }
  return { owed, fallbacks };
}

/**
 * The plan's checks only warnings a stop deferred owe (#2081): the checks the stop's warning says run while the script
 * plays instead, each check field of the plan once, a part check each. A check a published warning or a boundary also
 * owes runs whether or not the analysis stops: it is not one the stop moved.
 */
function movedChecks(
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
  owers: Owers,
): number {
  const moved = (site: CheckSite): boolean => owers.stopped.has(site) && !owers.published.has(site);
  let count = 0;
  for (const site of [
    ...checks.keys(),
    ...core.requireExisting,
    ...core.indexChecks,
    ...core.fallbackChecks.keys(),
  ])
    if (moved(site)) count += 1;
  for (const [store, parts] of core.partChecks) if (moved(store)) count += parts.length;
  return count;
}

/**
 * The runtime checks the core's obligations owe, through S3 §4's discharge map: C1's and C9's at the store that brings
 * the value into its place, the destination's written type or, else, its admitted type at the stored path, one check per
 * store whatever the obligations inside its value; a typed load's own type (F18), which repairs an object per field
 * (ADR 0021 rule 6.5); and the new content only the core emits (`CoreRuntimeChecks`): a property store that needs the
 * property (C5c), a list `get` that needs a whole number (C2), the check of a selected fallback or default (C10) and
 * `fromJson`'s expected type (F18). A boundary at a load or a `fromJson` that no store takes is its own type's.
 */
function runtimeChecks(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): {
  checks: Map<RuntimeCheckSite, TypeCheckPlan>;
  core: CoreRuntimeChecks;
  contracts: ReadonlyMap<Store, ContractResult>;
  moved: number;
} {
  const textOf = (node: Expression): string => {
    const file = index.fileOf(node);
    return request.files[file]!.source.slice(node.span.start.offset, node.span.end.offset);
  };
  const contracts = new Contracts(answers, index, declarations(answers, index));
  const checks = new Map<RuntimeCheckSite, TypeCheckPlan>();
  const core = {
    requireExisting: new Set<AssignmentStatement>(),
    indexChecks: new Set<CallExpression>(),
    fallbackChecks: new Map<BinaryExpression | CallExpression, TypeCheckPlan>(),
    expected: new Map<CallExpression, TypePlan>(),
    repairs: new Set<LoadExpression>(),
    partChecks: new Map<Store, readonly PartCheckPlan[]>(),
  };
  const owers: Owers = { published: new Set(), stopped: new Set() };
  const { owed, fallbacks } = warningChecks(answers, index, core, owers);
  for (const [owner, { fallback, depths }] of fallbacks) {
    const type = fallbackPlan(
      fallback,
      depths,
      (steps) => contracts.takesNull(owner, steps),
      (steps) => contracts.direct(owner, steps),
    );
    if (type !== null)
      core.fallbackChecks.set(owner, { type, place: `the value of '${textOf(owner)}'` });
  }
  // (a boundary carries the kinds it was retained with through the discharge, never derived again)
  for (const check of answers.checks)
    if (check.boundary && !leftOutCheck(check))
      owed.push({
        obligation: check,
        kinds: check.against.filter(
          (kind): kind is Exclude<typeof kind, "non-null"> => kind !== "non-null",
        ),
        by: owers.published,
      });
  // the types a typed load and a `fromJson` read their value as (F18)
  const typed = new Set<Expression>();
  for (const load of index.loads) {
    const type = contracts.expected(load);
    if (type === null) continue;
    typed.add(load);
    checks.set(load, { type, place: `Storage key ${textOf(unwrap(load.key))}` });
    if (repairedObject(type) !== undefined) core.repairs.add(load);
  }
  for (const call of index.calls)
    if (call.callee.kind === "identifier" && call.callee.name === "fromJson") {
      const type = contracts.expected(call);
      if (type === null) continue;
      typed.add(call);
      core.expected.set(call, type);
    }
  const stopped = answers.budget.exhausted !== null;
  // each store's owed obligations, for the parts below its destination its own check does not reach (#1224)
  const atStore = new Map<Store, Obligation[]>();
  for (const { obligation, kinds, by } of owed) {
    // a boundary check against `unknown` is the runtime's validation of representable external data, which runs for
    // every plan: no plan content (S3 §4); where a stopped decision left a store's own check against `unknown` (no
    // boundary's), the receiving completion completed its contract and its own store check owes a check at this site,
    // as the unstopped analysis does (#1526 phase C step 5), the store checks that contract
    if (obligation.against.length === 1 && obligation.against[0] === "unknown") {
      const at =
        !obligation.boundary && answers.completedCheck(obligation.site) && !leftOutCompletion()
          ? index.findExpressionAt(obligation.site)
          : undefined;
      const owner = at === undefined ? undefined : index.storeOf(at);
      if (owner === undefined || !contracts.completes(owner)) continue;
    }
    const expression = index.expressionAt(obligation.site);
    const store = index.storeOf(expression);
    if (store === undefined) {
      if (obligation.boundary && typed.has(expression)) continue;
      // (a loop variable's check has no place in the plan yet: its loop stays outside the slice)
      for (let at: Expression | undefined = expression; at !== undefined; at = index.parentOf(at))
        if (index.iterates(at)) throw new OutsideContract(at, "a check of a loop variable");
      throw new Error("A check of the slice belongs to no store.");
    }
    by.add(store);
    const held = atStore.get(store);
    if (held === undefined) atStore.set(store, [obligation]);
    else held.push(obligation);
    if (checks.has(store)) continue;
    const type = contracts.stored(store) ?? (stopped ? storedKinds(store, kinds) : null);
    if (type !== null) checks.set(store, type);
  }
  // after a demand stop, the obligations the receiving completion's own store checks owe (#1682): the natural walk's of
  // the decisions it made on the settled pass's inputs, each at its store as the unstopped one is, for that store's
  // parts only (its own check stays step 5's), merged into its owed ones in the published order (none where the
  // completion's records are left out: no completion runs, `asked`)
  const completed = new Map<Store, Obligation[]>();
  for (const warning of answers.completedWarnings()) {
    if (leftOutWarning(warning) || index.fallbackOf(index.expressionAt(warning.site)) !== undefined)
      continue;
    const store = index.storeOf(index.expressionAt(warning.obligation.site));
    if (store === undefined) continue;
    // (owed after a stop only: the completion runs where the analysis stopped)
    owers.stopped.add(store);
    const held = completed.get(store);
    if (held === undefined) completed.set(store, [warning.obligation]);
    else held.push(warning.obligation);
  }
  if (completed.size > 0) {
    // (an obligation no warning owns, a boundary, after every warning's, in its own order: the sort is stable)
    const order = answers.publishedOrder();
    const at = (obligation: Obligation): number => order.get(obligation) ?? Number.MAX_SAFE_INTEGER;
    for (const [store, more] of completed)
      atStore.set(
        store,
        [...(atStore.get(store) ?? []), ...more].sort((a, b) => at(a) - at(b)),
      );
  }
  for (const [store, obligations] of atStore) {
    // (the label of the place it stores into, as `stored` finds it: no question beyond the store's own check's)
    const destination = contracts.destination(store);
    if (destination === undefined) continue;
    const whole = checks.get(store)?.type ?? null;
    // (each object type's properties by name, made once for every part the store's check is read at: no search per part)
    const named = new Map<TypePlan, ReadonlyMap<string, TypePlan>>();
    const parts = partChecksOf(destination, obligations).filter(
      (part) => whole === null || !reaches(whole, part.path, named),
    );
    if (parts.length > 0) core.partChecks.set(store, parts);
  }
  return { checks, core, contracts: contracts.results, moved: movedChecks(checks, core, owers) };
}

/**
 * #1526 decision 2, condition 1: while a required check is missing, the candidate publishes no plan that
 * lets the invalid value through unchecked. Every plan published after a stop is gated here, at the one seam `asked`
 * publishes through, against the capture its path has (`Answers.gated`): the receiving registry where a receiving
 * completion ran (#1526 phase C), its results; after a stop where none ran or it kept none, the registry's obligations
 * without results. Each obligation a store owes when the script runs, its C1 check (a warning the walk made) or its C9
 * boundary (external data entering), is Lost where the plan's check at its store does not carry its required contract
 * (`keeps`). The first Lost obligation, in the registry's source order, declines the program at its store
 * (`OutsideContract`): the stopped plan would otherwise run past a check the natural plan makes (ADR 0021 §1.10
 * column (2)). A program the analysis rejects has no plan and is not asked. Where admission did not settle there is no
 * registry and nothing is declined here: an unsettled stop is #1767's and #1252's. One visit per obligation of the
 * registry, whose making charged each one.
 */
function lostCheck(
  answers: Answers,
  index: SliceIndex,
  published: ReadonlyMap<Store, ContractResult>,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
): void {
  const gated = answers.gated();
  // (obligations a settled stop cannot establish: the program is declined at its first store, never read as owing none)
  if (gated === null) {
    const first = index.statements.find(
      (statement): statement is Store =>
        statement.kind === "letStatement" || statement.kind === "assignmentStatement",
    );
    if (first === undefined) return;
    throw new OutsideContract(
      first.kind === "letStatement" ? first.initializer : first.value,
      "a store whose required checks could not be established at the budget",
    );
  }
  for (const { obligation, result } of gated) {
    // (a stopped decision's own marks stand at every store of it, external data or not: the store's own C1 check and
    // its C9 boundary are the checks it owes when the script runs)
    if (obligation.epoch !== answers.epoch || obligation.slot.role === "stopped") continue;
    const store = index.storeAt(obligation.slot.site);
    if (
      store === undefined ||
      keeps(answers, index, store, obligation, result, published, checks, core)
    )
      continue;
    throw new OutsideContract(
      store.kind === "letStatement" ? store.initializer : store.value,
      "a store whose check was lost at the budget",
    );
  }
}

/**
 * Whether the plan keeps an obligation's check at its store (`lostCheck`): a shape the analysis proved, or one a complete
 * store check carries; a contract proved open; a complete store check (settled or received, its whole type); or a
 * contract the completion completed that a published check carries at the obligation's path: a typed parse's or load's
 * reader of the value stored at least as strict as the contract there (F18), the stored literal's own structure, its typed
 * calls' readers and its scalar leaves, at least as strict (`elementsCarry`), or, where the natural plan does not check the
 * store whole, its part checks there equal to it (#1682). With no result, a completion past its allowance or a stop of the
 * analysis, only a complete store check keeps it, else it declines (#1832). A stricter reader is never a lost check: it
 * accepts no more values than the natural reader. A check against bare `unknown` where the contract owes a domain carries
 * nothing.
 */
function keeps(
  answers: Answers,
  index: SliceIndex,
  store: Store,
  obligation: ReceivingObligation,
  result: ReceivingResult | null,
  published: ReadonlyMap<Store, ContractResult>,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
): boolean {
  const own = published.get(store);
  const whole = own?.state === "complete" && checks.has(store);
  // (no result, a completion past its allowance or a stop of the analysis: the plan is the settled pass's, and only its
  // complete store check carries what the obligation requires; a reader, even of a `let` of its own, may be weaker than a
  // later store makes the natural check, and a partial store check than the natural plan's, which nothing tells (#1832))
  if (result === null) return whole;
  // (a shape is the suitability the value's own structure proves where it is not lost; a complete result there is the
  // requirement's, which a shape owes no more of)
  if (obligation.extent === "shape" || "shape" in result) return result.state !== "lost" || whole;
  if (result.state === "open" || whole) return true;
  const value = unwrap(store.kind === "letStatement" ? store.initializer : store.value);
  // (a contract the completion completed is kept only by a published check that carries it at the obligation's path: a
  // typed parse's or load's reader of the value stored, or the store's part checks there; where the natural plan checks
  // the store whole, `completedCheck`, and publication did not, its parts stand for nothing, #1645's whole object)
  const contract = answers.received(obligation.place, obligation.path);
  const destination = answers.storedPlace(nodeOf(answers, index, store));
  if (
    result.state !== "complete" ||
    contract?.state !== "complete" ||
    destination === null ||
    destination.id !== obligation.place ||
    destination.path.some((step, at) => obligation.path[at] !== step)
  )
    return false;
  const below = obligation.path
    .slice(destination.path.length)
    .map((step) =>
      step === "element" || step === "entry" || step === "index" ? "[]" : propertyName(step),
    );
  // (a reader at least as strict as the contract there: one that checks more, as a typed parse's of an object whose
  // field the contract leaves open, still checks all the contract does)
  const carries = (type: TypePlan | null | undefined): boolean => {
    const at = type === null || type === undefined ? null : typeAt(type, below);
    return at !== null && narrower(at, contract.ref);
  };
  if (
    carries(readerOf(value, checks, core)) ||
    elementsCarry(value, below, contract.ref, checks, core)
  )
    return true;
  if (answers.completedCheck(index.site(value))) return false;
  // (the part checks at or below the obligation's path, at least one, each the contract's type there where it has one:
  // a weaker one stands for nothing, #1645's whole object)
  const parts = (core.partChecks.get(store) ?? []).filter((part) => {
    const steps = part.path.map((step) => ("element" in step ? "[]" : step.property));
    return steps.length >= below.length && below.every((step, at) => steps[at] === step);
  });
  return (
    parts.length > 0 &&
    parts.every((part) => {
      const steps = part.path.map((step) => ("element" in step ? "[]" : step.property));
      const at = typeAt(contract.ref, steps.slice(below.length));
      return at === null || JSON.stringify(part.type) === JSON.stringify(at);
    })
  );
}

/** The type a typed parse or load reads its value as (F18), `undefined` for any other value. */
function readerOf(
  value: Expression,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
): TypePlan | undefined {
  return value.kind === "loadExpression"
    ? checks.get(value)?.type
    : value.kind === "callExpression"
      ? core.expected.get(value)
      : undefined;
}

/**
 * Whether a stored literal carries a contract at `below` (property names and `[]` for an element) by its own structure:
 * followed through its properties and elements to the contract's level, a list or set whose every element carries the
 * contract's element, an object whose property carries each property the contract lists, a typed parse's or load's whole
 * value whose reader is at least as strict as the contract there, or a scalar literal of a kind at least as strict. The
 * value itself is a literal holding them, never the call alone (`readerOf`'s).
 */
function elementsCarry(
  value: Expression,
  below: readonly string[],
  contract: TypePlan,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
): boolean {
  const carried = (at: Expression, steps: readonly string[], type: TypePlan): boolean => {
    const node = unwrap(at);
    if (node.kind === "listLiteral" || node.kind === "setLiteral") {
      if (steps.length > 0)
        return (
          steps[0] === "[]" &&
          node.elements.length > 0 &&
          node.elements.every((one) => carried(one, steps.slice(1), type))
        );
      const element =
        node.kind === "listLiteral"
          ? type.kind === "list"
            ? type.element
            : undefined
          : type.kind === "set"
            ? type.element
            : undefined;
      if (element === undefined) return false;
      return element === null || node.elements.every((one) => carried(one, [], element));
    }
    if (node.kind === "objectLiteral") {
      if (steps.length > 0) {
        const property = node.properties.find((one) => one.name.name === steps[0]);
        return property !== undefined && carried(property.value, steps.slice(1), type);
      }
      if (type.kind !== "object") return false;
      // (the literal's properties indexed once: the walk visits each property at most once, as the store's own check of
      // the value does, so its work is that check's, charged where publication made it)
      const own = new Map(node.properties.map((one) => [one.name.name, one.value]));
      return type.properties.every((wanted) => {
        const value = own.get(wanted.name);
        return value !== undefined && carried(value, [], wanted.type);
      });
    }
    const leaf = leafKind(node);
    if (leaf !== null) return steps.length === 0 && narrower(leaf, type);
    const reader = readerOf(node, checks, core);
    const there = reader === undefined ? null : typeAt(reader, steps);
    return there !== null && narrower(there, type);
  };
  const root = unwrap(value);
  return (
    (root.kind === "listLiteral" || root.kind === "setLiteral" || root.kind === "objectLiteral") &&
    carried(root, below, contract)
  );
}

/** The type a scalar literal proves by its own syntax, `null` for any other expression. */
function leafKind(node: Expression): TypePlan | null {
  switch (node.kind) {
    case "numberLiteral":
      return { kind: node.numericType };
    case "stringLiteral":
      return { kind: "string" };
    case "booleanLiteral":
      return { kind: "boolean" };
    case "nullLiteral":
      return { kind: "null" };
    default:
      return null;
  }
}

/**
 * Whether every value a check against `narrow` passes also passes one against `wide` (a check checks only the listed
 * properties an object has, and every element of a collection whose element type is not `null`): a reader that carries
 * a contract (`keeps`).
 */
export function narrower(narrow: TypePlan, wide: TypePlan): boolean {
  if (narrow.kind === "union") return narrow.members.every((member) => narrower(member, wide));
  if (wide.kind === "union") return wide.members.some((member) => narrower(narrow, member));
  if (wide.kind === "object") {
    if (narrow.kind !== "object") return false;
    const own = new Map(narrow.properties.map((each) => [each.name, each.type]));
    return wide.properties.every((property) => {
      const type = own.get(property.name);
      return type !== undefined && narrower(type, property.type);
    });
  }
  if (wide.kind === "list" || wide.kind === "set" || wide.kind === "dict") {
    if (narrow.kind !== "list" && narrow.kind !== "set" && narrow.kind !== "dict") return false;
    return (
      narrow.kind === wide.kind &&
      (wide.element === null || (narrow.element !== null && narrower(narrow.element, wide.element)))
    );
  }
  // (a whole number is a number)
  return narrow.kind === wide.kind || (narrow.kind === "integer" && wide.kind === "number");
}

/** A type plan's part at a path of property names and `[]` (an element, entry or value), `null` where it has none. */
function typeAt(type: TypePlan, steps: readonly string[]): TypePlan | null {
  let at: TypePlan | null = type;
  for (const step of steps)
    at =
      at === null
        ? null
        : step === "[]"
          ? at.kind === "list" || at.kind === "set" || at.kind === "dict"
            ? at.element
            : null
          : at.kind === "object"
            ? (at.properties.find((property) => property.name === step)?.type ?? null)
            : null;
  return at;
}

/**
 * The part checks a store's owed obligations below its destination make (#1224, the lead's ruling (c)): one per obligation
 * the analysis owes at the store below its destination (`destination`, the label of the place it stores into), with
 * the obligation's kinds at the steps its target names below the destination (`pathText`'s: a property's name, quoted
 * for an internal one, `element`, `entry` or `index` for an element). None is made for an obligation at the destination
 * itself, for one whose kinds leave its part open, or for a step of another form: nothing is checked that the analysis
 * does not owe there.
 */
function partChecksOf(destination: string, obligations: readonly Obligation[]): PartCheckPlan[] {
  const out: PartCheckPlan[] = [];
  const made = new Set<string>();
  for (const obligation of obligations) {
    if (!obligation.target.startsWith(`${destination}.`)) continue;
    const type = kindsPlan(obligation.against);
    const part =
      type === null
        ? null
        : partOf(destination, obligation.target.slice(destination.length + 1).split("."), type);
    if (part === null) continue;
    const key = JSON.stringify([part.path, part.type]);
    if (made.has(key)) continue;
    made.add(key);
    out.push(part);
  }
  return out;
}

/**
 * A part check of `type` at `steps` below a destination (`pathText`'s steps: a property's name, quoted for an internal
 * one, `element`, `entry` or `index` for an element), its place the path as messages name one (`pathPhrase`); `null` for
 * a step of another form, which makes no part.
 */
function partOf(
  destination: string,
  steps: readonly string[],
  type: TypePlan,
): PartCheckPlan | null {
  const path: PartStep[] = [];
  for (const step of steps)
    if (step === "element" || step === "entry" || step === "index") path.push({ element: true });
    else if (
      step !== "iteration" &&
      (step.startsWith("'") || /^[\p{L}_][\p{L}\p{N}_]*$/u.test(step))
    )
      path.push({ property: propertyName(step) });
    else return null;
  // (the place as messages name a path below one in words: `'copy.open'`, `an element of 'copy.xs'`)
  const [root, ...above] = destination.split(".");
  return {
    path,
    type,
    place: pathPhrase({ code: root! }, [
      ...above,
      ...steps.map((step) => (step === "index" ? "element" : step)),
    ]),
  };
}

/**
 * Whether a store's check of `type` checks every value at `path` below it (`named`: each object type's properties by
 * name, shared by the store's parts): each member that can hold the next step (an
 * object, or a collection for an element) lists it and checks below it; a member that cannot hold it leaves no value
 * there. An open level (an object without the property, a collection whose elements are open) reaches nothing below.
 */
function reaches(
  type: TypePlan,
  path: readonly PartStep[],
  named: Map<TypePlan, ReadonlyMap<string, TypePlan>>,
): boolean {
  const pending: [TypePlan, number][] = [[type, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [at, depth] = next;
    if (depth === path.length) continue;
    const step = path[depth]!;
    if (at.kind === "union") {
      for (const member of at.members) pending.push([member, depth]);
      continue;
    }
    if ("property" in step) {
      if (at.kind !== "object") continue;
      let properties = named.get(at);
      if (properties === undefined) {
        const byName = new Map<string, TypePlan>();
        for (const property of at.properties)
          if (!byName.has(property.name)) byName.set(property.name, property.type);
        named.set(at, (properties = byName));
      }
      const found = properties.get(step.property);
      if (found === undefined) return false;
      pending.push([found, depth + 1]);
    } else if (at.kind === "list" || at.kind === "set" || at.kind === "dict") {
      if (at.element === null) return false;
      pending.push([at.element, depth + 1]);
    }
  }
  return true;
}

/**
 * Test-only: each checked store's contract result (`ContractDescriptors`), by the store's site (`file:start:end`), as
 * the compiler's checks read them (`asked`).
 */
export function storeContracts(
  answers: Answers,
  request: CoreAnalysisRequest,
): ReadonlyMap<string, ContractResult> {
  const index = new SliceIndex(request.files.map((file) => file.program));
  return asked(answers, (answers) => {
    const out = new Map<string, ContractResult>();
    for (const [store, result] of runtimeChecks(answers, index, request).contracts)
      out.set(`${index.fileOf(store)}:${store.span.start.offset}:${store.span.end.offset}`, result);
    return out;
  });
}

/**
 * A store's check by the kinds its warning names, where a stopped analysis decided no type to check it against (D4 a′):
 * the type admission decided before the stop, its kinds' containers unrestricted below them.
 */
function storedKinds(store: Store, kinds: readonly ItemTag[] | null): TypeCheckPlan | null {
  const types = (kinds ?? []).map(closedType).filter((type): type is StaticType => type !== null);
  const type = types.length === 0 ? null : typePlan(union(types));
  if (type === null) return null;
  const target =
    store.kind === "letStatement"
      ? store.name.name
      : store.target.kind === "identifier"
        ? store.target.name
        : null;
  return { type, place: target === null ? "the place" : `'${target}'` };
}

/** C10's obligation at one depth of a fallback: its element steps below the fallback, and the kinds it requires there. */
interface FallbackDepth {
  readonly steps: readonly string[];
  readonly against: readonly RequiredKind[];
}

/** The element steps of a C10 target below the fallback named `name` (`targetName`), or `null` for another (a C1's). */
function fallbackSteps(target: string, name: string | null): string[] | null {
  if (name === null) return null;
  if (target === name) return [];
  if (!target.startsWith(`${name}.`)) return null;
  const steps = target.slice(name.length + 1).split(".");
  return steps.every((step) => step === "element" || step === "entry") ? steps : null;
}

/**
 * The check of a selected fallback from C10's obligations at its depths (ADR 0021 7.2, nested literals by their
 * elements): at each depth the kinds required there, `null` below the fallback itself where `takesNull` allows it, the
 * collection below it as the fallback's literal is one, else a list or a set for an element and a dict for an entry;
 * `null` where no depth requires a kind. Where C10 publishes nothing below a collection no literal holds, that collection
 * is checked whole, as the value the fallback stands in for is at that depth (`whole`), not its first level alone (Astra
 * r1's B1 on #1539); where that value gives no collection there the program leaves the slice.
 */
function fallbackPlan(
  fallback: Expression,
  depths: readonly FallbackDepth[],
  takesNull: (steps: readonly string[]) => boolean,
  whole: (steps: readonly string[]) => TypePlan | null,
): TypePlan | null {
  const deepest = depths.reduce((most, depth) => Math.max(most, depth.steps.length), 0);
  // the literal the fallback's value is at each depth, as far as a literal holds it
  const literals: (Expression | null)[] = [];
  for (
    let at: Expression | null = selectedLiteral(fallback), depth = 0;
    depth <= deepest;
    depth += 1
  ) {
    literals.push(at);
    at =
      at !== null &&
      (at.kind === "listLiteral" || at.kind === "setLiteral") &&
      at.elements.length > 0
        ? selectedLiteral(at.elements[0]!)
        : null;
  }
  let below: TypePlan | null = null;
  for (let depth = deepest; depth >= 0; depth -= 1) {
    const here = depths.filter((entry) => entry.steps.length === depth);
    const kinds = here.flatMap((entry) => entry.against);
    const step = depths.find((entry) => entry.steps.length > depth)?.steps[depth];
    const literal = literals[depth] ?? null;
    const collections: TypePlan[] =
      below === null || step === undefined
        ? []
        : step === "entry"
          ? [{ kind: "dict", element: below }]
          : literal?.kind === "listLiteral"
            ? [{ kind: "list", element: below }]
            : literal?.kind === "setLiteral"
              ? [{ kind: "set", element: below }]
              : [
                  { kind: "list", element: below },
                  { kind: "set", element: below },
                ];
    // below the fallback itself an element may be `null` too, unless a written place it lands in excludes it (C10)
    const steps = depths.find((entry) => entry.steps.length >= depth)?.steps.slice(0, depth) ?? [];
    if (literal === null && collections.length === 0 && kinds.some(isCollection)) {
      const complete = whole(steps);
      const held =
        complete === null ? [] : membersOf(complete).filter((member) => isCollection(member.kind));
      if (held.length === 0)
        throw new OutsideContract(
          fallback,
          "a default whose collection the value it stands in for does not type",
        );
      const scalars = kindsPlan(kinds.filter((kind) => !isCollection(kind)));
      below = unionOf([
        ...held,
        ...(scalars === null ? [] : [scalars]),
        ...(depth > 0 && takesNull(steps) ? [{ kind: "null" } as const] : []),
      ]);
      continue;
    }
    const others = kindsPlan([
      ...(collections.length === 0
        ? kinds
        : kinds.filter((kind) => kind !== "list" && kind !== "set" && kind !== "dict")),
      ...(depth > 0 && (kinds.length > 0 || collections.length > 0) && takesNull(steps)
        ? (["null"] as const)
        : []),
    ]);
    const parts = [...collections, ...(others === null ? [] : [others])];
    below = parts.length === 0 ? null : unionOf(parts);
  }
  return below;
}

/** The literal a value is, through parentheses and constant indexes of list literals, or `null`. */
function selectedLiteral(expression: Expression): Expression | null {
  let at = unwrap(expression);
  while (at.kind === "indexExpression") {
    const list = unwrap(at.object);
    const index = unwrap(at.index);
    const element =
      list.kind === "listLiteral" && index.kind === "numberLiteral"
        ? list.elements[index.value]
        : undefined;
    if (element === undefined) return null;
    at = unwrap(element);
  }
  return at.kind === "listLiteral" || at.kind === "setLiteral" || at.kind === "dictLiteral"
    ? at
    : null;
}

/** The plan of the kinds an obligation requires: each kind, a collection's elements and an object's properties left open. */
function kindsPlan(kinds: readonly (ItemTag | RequiredKind)[]): TypePlan | null {
  const members = [...new Set(kinds)].flatMap((kind): TypePlan[] =>
    kind === "non-null" || kind === "unknown" || kind === "empty" ? [] : [kindPlan(kind)],
  );
  if (kinds.includes("unknown") || members.length === 0) return null;
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

/** A kind's plan with its parts left open. */
function kindPlan(kind: ValueKind): TypePlan {
  if (kind === "list" || kind === "set" || kind === "dict") return { kind, element: null };
  if (kind === "object") return { kind: "object", properties: [] };
  return { kind };
}

/**
 * Every value: the plan of a level below a typed parse's or load's value whose type nothing settles (an unknown, or a
 * `null` in its default, ADR 0021 2.6), which a record must still have, so that a missing field takes the default's.
 */
const ANY_VALUE: TypePlan = { kind: "union", members: VALUE_KIND_NAMES.map(kindPlan) };

function unwrap(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

/**
 * A contract the plan cannot carry exactly as the core decided it: one deeper than the slice follows (`SLICE_DEPTH`), a
 * record field that some records of a list lack, a typed parse or load into a copy of a written type, a typed parse's or
 * load's default a stop left open (#1767). The candidate route rejects its program, at `expression`, rather than check
 * less than the core decided.
 */
export class OutsideContract extends Error {
  public constructor(
    readonly expression: Expression,
    readonly what: string,
  ) {
    super(`The slice does not follow ${what}.`);
    this.name = "OutsideContract";
  }
}

// (the backend's slice rule reads the facts' depth here, where it read it before the service had it)
export { SLICE_DEPTH };

/** A value whose contract is deeper than the slice follows (`SLICE_DEPTH`): the program leaves the slice at it. */
function outsideStructure(at: Expression): never {
  throw new OutsideContract(at, "a value whose structure the slice does not follow");
}

/** Where a value lands directly: the place a store brings it into, and the path below the place's root. */
interface Landing {
  readonly id: PlaceId;
  readonly path: readonly string[];
}

/**
 * The contracts the plan content of one program carries, each read from the core's answers, never rebuilt from the
 * source (S3 §4, F18, C9, C10): a place's contract at a path, objects with their decided properties; the type a typed
 * parse or load reads its value as, the core's own answer at the call; where a fallback lands, for C10's `null`. Built
 * on one task stack, so deep values do not deepen the native stack.
 */
class Contracts {
  readonly #landings = new Map<Expression, Landing | null>();
  readonly #literals = new Map<Expression, Expression | null>();
  /** The stores' contracts (`ContractDescriptors`), read through the answers' places. */
  readonly #descriptors: ContractDescriptors<readonly Expression[]>;
  /** Each checked store's contract result, as `stored` made it. */
  readonly results = new Map<Store, ContractResult>();
  /** Each store's label of the place it stores into (`destination`), once. */
  readonly #destinations = new Map<Store, string | undefined>();

  public constructor(
    private readonly answers: Answers,
    private readonly index: SliceIndex,
    private readonly lets: ReadonlyMap<PlaceId, LetStatement>,
  ) {
    this.#descriptors = new ContractDescriptors(
      {
        level: (id, path) => {
          const place = answers.place(id, path);
          return levelProof(place.admitted, () => place.contract.kinds);
        },
        properties: (id, path) => answers.placeProperties(id, path),
      },
      (records) => {
        const below = recordsBelow(records, this.#literalOf);
        return {
          elements: below.elements,
          field: (name) => below.fields.get(name) ?? [],
          order: (names) => fieldOrder(names, below, index),
        };
      },
      answers.epoch,
      // (statements nested past the limit stop nothing: a decision's stop is the cause there)
      answers.budget.exhausted !== null && answers.budget.exhausted !== "nesting",
    );
  }

  /**
   * The check of a store: the destination's written type, else the complete type a stop below its path left it to check
   * whole (`Answers.requirement`, #1416), else its contract at the stored path (A1–A9): a complete one's, a lost one's
   * part (decision 2 pending), none for an open one.
   */
  public stored(store: Store): TypeCheckPlan | null {
    const declaration = declarationOf(this.answers, this.index, this.lets, store);
    const value = store.kind === "letStatement" ? store.initializer : store.value;
    const whole = store.kind === "letStatement" || store.target.kind === "identifier";
    const place = this.answers.at(nodeOf(this.answers, this.index, store))?.place ?? null;
    const required = place === null ? null : this.answers.requirement(place.id, place.path);
    this.destination(store);
    const result =
      whole && declaration.typeAnnotation !== null
        ? this.#descriptors.written(
            typePlan(typeFromAnnotation(declaration.typeAnnotation)),
            place?.id ?? null,
            place?.path ?? [],
          )
        : required !== null
          ? this.#descriptors.written(
              typePlan(runCompileTask(termTask(required))),
              place!.id,
              place!.path,
            )
          : place === null
            ? null
            : this.#completed(
                place.id,
                place.path,
                this.#descriptors.result(place.id, place.path, [value], () =>
                  outsideStructure(value),
                ),
              );
    if (result !== null) this.results.set(store, result);
    const type = result === null ? null : checkedType(result);
    if (type === null) return null;
    const name = [
      declaration.name.name,
      ...(whole ? [] : (place?.path ?? []).map(propertyName)),
    ].join(".");
    return { type, place: `'${name}'` };
  }

  /**
   * The label of the place a store stores into (its variable, then the core's steps), as `stored` reads it, once per
   * store; `undefined` where the answers name no place there. It reads no value and asks for no contract, so a store
   * whose only owed checks are the receiving completion's is asked nothing (#1682).
   */
  public destination(store: Store): string | undefined {
    if (this.#destinations.has(store)) return this.#destinations.get(store);
    const place = this.answers.storedPlace(nodeOf(this.answers, this.index, store));
    const declaration =
      store.kind === "letStatement" ? store : place === null ? undefined : this.lets.get(place.id);
    const label =
      place === null || declaration === undefined
        ? undefined
        : [declaration.name.name, ...place.path].join(".");
    this.#destinations.set(store, label);
    return label;
  }

  /** Whether the receiving completion completed the contract at a store's destination (`#completed`). */
  public completes(store: Store): boolean {
    const place = this.answers.at(nodeOf(this.answers, this.index, store))?.place ?? null;
    return place !== null && this.answers.received(place.id, place.path) !== null;
  }

  /**
   * A store's contract where the settled pass's own is not complete (a decision on its path stopped): the receiving
   * completion's complete contract there (#1526 phase C step 5), else the settled pass's (a lost one's part, decision 2
   * pending). A completion's lost result never stands in, so nothing is widened.
   */
  #completed(id: PlaceId, path: readonly string[], settled: ContractResult): ContractResult {
    if (settled.state === "complete" || leftOutCompletion()) return settled;
    return this.answers.received(id, path) ?? settled;
  }

  /**
   * The type a typed load or `fromJson` reads its value as (F18, S3 §3): the core's own answer at the call, level by
   * level (`#answerTask`); `null` where the call's kinds hold an unknown or only `null` (F19), or a load's key is
   * computed; the program leaves the slice where a stop left a level of the answer open (#1767).
   */
  public expected(call: CallExpression | LoadExpression): TypePlan | null {
    if (call.kind === "loadExpression" && unwrap(call.key).kind !== "stringLiteral") return null;
    // (after a stop only literal data proves a default, by its own syntax at every level (#1460): below a read the
    // answer is the value side's, which the stop left unproven (A6: the stores admission rejects are unsettled), so
    // the program leaves the slice rather than read what the natural plan may not, #1526 condition 1, #1767)
    const fallback = call.kind === "loadExpression" ? call.defaultValue : defaultOf(call);
    const landing = this.#landing(call);
    // (a written scalar destination is the reader type itself, whatever its default reads: Codex r5's P2; asked only
    // after such a stop, so an unstopped compile asks nothing more)
    const scalar = (): boolean => {
      const written =
        landing === null ? null : this.answers.place(landing.id, landing.path).admitted;
      return (
        written !== null &&
        written.by === "written" &&
        written.kinds.length > 0 &&
        written.kinds.every((kind) => !STRUCTURED.has(kind))
      );
    };
    if (fallback !== null && stoppedAnalysis(this.answers) && readsPlace(fallback) && !scalar())
      throw new OutsideContract(call, OPEN_BY_STOP);
    const expected = runCompileTask(
      this.#answerTask(
        { node: nodeOf(this.answers, this.index, call), call, landing, keeps: false },
        [],
        [call],
      ),
    );
    // a copy of a written type is F18's receiving context (A4, (1a)), at every level the call's value
    // reaches, but the core answers the call by its default there while its later facts follow that answer: the
    // lowering cannot widen it alone
    if (
      landing !== null &&
      expected !== null &&
      levelsOf(expected).some((level) => {
        const admitted = this.answers.place(landing.id, [...landing.path, ...level]).admitted;
        return admitted.by === "decided" && admitted.inherited;
      })
    )
      throw new OutsideContract(call, "a typed parse or load into a copy of a written type");
    return expected;
  }

  /**
   * The literal data a value is at its level, whose records give a record's fields their order (`fieldOrder`): itself,
   * through parentheses and a typed parse's or load's default, each typed call's once (a chain of nested defaults is
   * followed once), `null` for a typed one without a default.
   */
  readonly #literalOf = (value: Expression): Expression | null => {
    const chain: Expression[] = [];
    let found: Expression | null = null;
    for (let node: Expression | null = unwrap(value); node !== null;) {
      const known = this.#literals.get(node);
      if (known !== undefined) {
        found = known;
        break;
      }
      const inner = typedDefault(node);
      if (inner === undefined) {
        found = node;
        break;
      }
      chain.push(node);
      node = inner === null ? null : unwrap(inner);
    }
    for (const call of chain) this.#literals.set(call, found);
    return found;
  };

  /**
   * The complete contract of the value a fallback stands in for at `steps` below it (C10, ADR 0021 7.2): a `get`'s value,
   * an `otherwise`'s left one without `null`, as `#provenanceOf` finds it; `null` for another owner.
   */
  public direct(
    owner: BinaryExpression | CallExpression,
    steps: readonly string[],
  ): TypePlan | null {
    const value =
      owner.kind === "binaryExpression" ? owner.left : getReceiver(owner) === null ? null : owner;
    if (value === null) return null;
    // (a contract's path names a dict's value its element, as every key does)
    const below = steps.map(() => "element");
    const landing = this.#landing(owner);
    const { contract, written } = this.#provenanceOf(
      value,
      below,
      landing === null ? null : { id: landing.id, path: joinSteps(landing.path, below) },
    );
    // a written level, or one a copy inherits from a written type (A4, ADR 0021 1.3), keeps its type; any other is checked
    // in C10's family, whole numbers with numbers (ADR 0021 1.2, 7.2): never stricter than C10 for the same default
    // written out (Codex r3, r4 on #1539)
    const checked = contract === null ? null : numberFamily(contract, (levels) => !written(levels));
    return checked === null || owner.kind === "callExpression" || steps.length > 0
      ? checked
      : withoutNull(checked);
  }

  /**
   * The value an expression gives at `path` below it as the core answers for it, with the provenance of each level below
   * that: the fallback completion's one lookup. Parentheses give their content's value, as `nodeOf` reads them. A
   * place's value has its place's contract, each level written where the core answers its domain as written or as
   * inherited from a written type. A `get`'s value is its receiver's element. An `otherwise` chain's value joins its
   * operands' as the core admits a join (A4): a level is written where any operand that brings a collection (a `null` or
   * a scalar brings none) is written there; the contract is theirs where they agree, else the core's admitted contract
   * of the place the value at `path` lands in (`landing`, the one its receiving check is against), and none where it
   * lands in none or an operand's is open. Any other value is the core's answer for it by its own text (a literal, an
   * operation, another call), unwritten.
   */
  #provenanceOf(value: Expression, path: readonly string[], landing: Landing | null): Provenance {
    const read = unwrap(value);
    const node = nodeOf(this.answers, this.index, read);
    const place = this.answers.at(node)?.place ?? null;
    if (place !== null) {
      const at = joinSteps(place.path, path);
      return {
        contract: this.#contract(place.id, at, read),
        written: (levels) =>
          writtenDomain(this.answers.place(place.id, joinSteps(at, levels)).admitted),
      };
    }
    const receiver = getReceiver(read);
    if (receiver !== null)
      return this.#provenanceOf(receiver, joinSteps(["element"], path), landing);
    if (read.kind === "binaryExpression" && read.operator === "otherwise") {
      const joined = [read.left, read.right]
        .filter((operand) =>
          bringsCollection(this.answers.valueAt(nodeOf(this.answers, this.index, operand), [])),
        )
        .map((operand) => this.#provenanceOf(operand, path, landing));
      const contract = joined[0]?.contract ?? null;
      if (joined.some((part) => part.contract === null))
        return { contract: null, written: () => false };
      if (contract !== null && joined.every((part) => samePlan(part.contract!, contract)))
        return { contract, written: (levels) => joined.some((part) => part.written(levels)) };
      if (contract !== null) {
        // (operands of written types that differ: the core admits the join where it lands, by its copies, Codex r6)
        if (landing === null)
          throw new OutsideContract(read, "a join of different written types that no place admits");
        return {
          contract: this.#contract(landing.id, landing.path, read),
          written: (levels) =>
            writtenDomain(this.answers.place(landing.id, joinSteps(landing.path, levels)).admitted),
        };
      }
    }
    return { contract: runCompileTask(this.#answeredTask(node, path, read)), written: () => false };
  }

  /**
   * The core's answer at `path` below a value no place holds, as a plan: its kinds, whole numbers among numbers as
   * numbers, a collection's elements by the same rule, an object open; open (`null`) where it may hold an unknown or holds
   * nothing.
   */
  *#answeredTask(
    node: FlowNode,
    path: readonly string[],
    at: Expression,
  ): CompileTask<TypePlan | null> {
    const held = new Set<ItemTag>();
    for (const item of this.answers.valueAt(node, path).items)
      if (item.tag !== "empty") held.add(item.tag);
    if (held.has("unknown") || held.size === 0) return null;
    if (path.length + 1 >= SLICE_DEPTH)
      throw new OutsideContract(at, "a value whose structure the slice does not follow");
    if (held.has("number")) held.delete("integer");
    const collection = held.has("list") || held.has("set") || held.has("dict");
    const element = collection
      ? yield* compileChild(this.#answeredTask(node, joinSteps(path, ["element"]), at))
      : null;
    const members = [...held]
      .filter((kind): kind is ValueKind => kind !== "unknown" && kind !== "empty")
      .map((kind) =>
        kind === "list" || kind === "set" || kind === "dict" ? { kind, element } : kindPlan(kind),
      );
    return members.length === 1 ? members[0]! : { kind: "union", members };
  }

  /**
   * Whether an element of a fallback at `steps` below it may be `null` (C10): unless the fallback lands directly in a
   * written place whose type there excludes it.
   */
  public takesNull(owner: Expression, steps: readonly string[]): boolean {
    const landing = this.#landing(owner);
    if (landing === null) return true;
    const admitted = this.answers.place(landing.id, [...landing.path, ...steps]).admitted;
    return admitted.by !== "written" || admitted.kinds.includes("null");
  }

  /**
   * Where `value` lands directly (ADR 0021 rule 7.3): through parentheses, either operand of `otherwise`, the `default:`
   * of a call or a load, a list's or set's element and an object's property, to the value a store brings into a place;
   * `null` where it lands in none.
   */
  #landing(value: Expression): Landing | null {
    const climbed: [Expression, readonly string[]][] = [];
    let base: Landing | null = null;
    for (let node = value; ;) {
      const known = this.#landings.get(node);
      if (known !== undefined) {
        base = known;
        break;
      }
      const parent = this.index.parentOf(node);
      if (parent === undefined) {
        const store = this.index.storeOf(node);
        const place =
          store === undefined ||
          (store.kind === "letStatement" ? store.initializer : store.value) !== node
            ? null
            : (this.answers.at(nodeOf(this.answers, this.index, store))?.place ?? null);
        base = place === null ? null : { id: place.id, path: place.path };
        this.#landings.set(node, base);
        break;
      }
      const step = landingStep(parent, node, this.index);
      if (step === null) {
        this.#landings.set(node, null);
        break;
      }
      climbed.push([node, step]);
      node = parent;
    }
    // the values climbed through land below their parent, from the outermost down
    for (let at = climbed.length - 1; at >= 0; at -= 1) {
      const [node, step] = climbed[at]!;
      base = base === null ? null : { id: base.id, path: [...base.path, ...step] };
      this.#landings.set(node, base);
    }
    return base;
  }

  /** A place's contract at a path as the plan's check carries it (`ContractDescriptors`), for a value read from it. */
  #contract(id: PlaceId, path: readonly string[], at: Expression): TypePlan | null {
    return checkedType(this.#descriptors.result(id, path, [], () => outsideStructure(at)));
  }

  /**
   * The core's answer at `path` below a call's value as a plan: its kinds (a written target's, else the default's,
   * F18), integers among numbers as numbers (the decided family, ADR 0021 1.2), a collection's elements and an object's
   * properties below by the same rule. At the call itself an unknown or only `null` gives no plan; below it such a level
   * takes every value (ADR 0021 2.6: `[]` leaves the element type open, a `null` in the default stays unknown). A
   * record's field that some of its sources lack (`missing`) has the kinds the others give, and a missing one is the
   * default's. The program leaves the slice where the plan cannot carry the core's answer exactly: where the place the
   * call lands in types such an open level (the core answers the call and the place differently there), where records
   * of a list a parse reads lack fields no default supplies, and deeper than the slice follows.
   */
  *#answerTask(
    at: AnsweredCall,
    path: readonly string[],
    records: readonly Expression[],
  ): CompileTask<TypePlan | null> {
    const found = this.answers.valueAt(at.node, path);
    // below a written `object` the default's own answer, as F18 takes a default's kinds (`contract.ts`'s `typedDefault`):
    // a `null` field stays open there too
    const decision = at.keeps ? defaultKinds(path, false) : null;
    const answer =
      decision === null
        ? found
        : { ...found, items: decision.answer(decision.choose(found.items), found.items) };
    const held = new Set<ItemTag>();
    let lacking = false;
    for (const item of answer.items) {
      if (item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) {
        lacking = true;
        if (item.reasons !== REASON.missing) held.add("unknown");
      } else if (item.tag !== "empty") held.add(item.tag);
    }
    // (a load's stored reader takes a listed field of an element where the element has it, `matchesValueType`, so a
    // field its elements may lack is the plan's as it is; JSON's requires every listed field: #1458)
    if (lacking && path.includes("element") && at.call.kind !== "loadExpression")
      throw new OutsideContract(at.call, "a value whose structure the slice does not follow");
    // (a level a stop left open is no open level: the plan would read every value there, the natural one its type, so
    // the program leaves the slice rather than publish a check less, #1526 condition 1, #1767)
    if (answer.items.some(stoppedItem)) throw new OutsideContract(at.call, OPEN_BY_STOP);
    if (held.has("number")) held.delete("integer");
    // an unknown, or an empty collection's elements, is open; a known `null` is the `null` type
    if (held.has("unknown") || held.size === 0) {
      if (path.length === 0) return null;
      if (at.landing !== null) {
        // (a level the place admits every kind at, an unrestricted part, V30 §13, types nothing)
        const { admitted } = this.answers.place(at.landing.id, [...at.landing.path, ...path]);
        if (admitted.by !== "undecided" && !admitted.kinds.includes("unknown"))
          throw new OutsideContract(
            at.call,
            "an open part of a typed parse's or load's default that its destination types",
          );
      }
      return ANY_VALUE;
    }
    if (path.length + 1 >= SLICE_DEPTH)
      throw new OutsideContract(at.call, "a value whose structure the slice does not follow");
    const members: TypePlan[] = [];
    const structured =
      held.has("list") || held.has("set") || held.has("dict") || held.has("object");
    const below = structured ? recordsBelow(records, this.#literalOf) : null;
    for (const tag of VALUE_KIND_NAMES.filter((kind) => held.has(kind)))
      if (tag === "list" || tag === "set" || tag === "dict") {
        const element = yield* compileChild(
          this.#answerTask(at, [...path, "element"], below?.elements ?? []),
        );
        // elements that take every value leave the collection open, as a store's check has it
        members.push({ kind: tag, element: element === ANY_VALUE ? null : element });
      } else if (tag === "object") {
        // a level the place's written type leaves any object (`object`), and every level below one, keeps every key of
        // the value; its properties are the default's, each by the literal data's own answer, as the call's below a
        // written `object` takes every value (#1223, the lead's ruling 1)
        const opens = !at.keeps && this.#writtenObject(at.landing, path);
        const literal = opens ? this.#literalOf(at.call) : null;
        const inner =
          literal === null
            ? at
            : { ...at, node: nodeOf(this.answers, this.index, literal), keeps: true };
        const own = opens && inner !== at ? this.answers.valueAt(inner.node, path) : null;
        // (below a written `object` the default's own answer, whose names the plan keeps: a level of it a stop left
        // open is no open level either, #1767)
        if (own !== null && own.items.some(stoppedItem))
          throw new OutsideContract(at.call, OPEN_BY_STOP);
        const names = !opens ? answer.properties : own === null ? [] : own.properties;
        const properties: TypePropertyPlan[] = [];
        for (const name of fieldOrder(names, below ?? NO_RECORDS, this.index))
          properties.push({
            name,
            // EVIDENCE: invariant: below the call a level always has a plan (`ANY_VALUE` at the least).
            type: (yield* compileChild(
              this.#answerTask(inner, [...path, propertyStep(name)], below?.fields.get(name) ?? []),
            ))!,
          });
        members.push(
          opens || at.keeps
            ? { kind: "object", properties, keepExtra: true }
            : { kind: "object", properties },
        );
      } else members.push(kindPlan(tag));
    return unionOf(members);
  }

  /** Whether the place a call lands in admits any object at `path` below it by its written type (`object`). */
  #writtenObject(landing: Landing | null, path: readonly string[]): boolean {
    if (landing === null) return false;
    const { admitted } = this.answers.place(landing.id, joinSteps(landing.path, path));
    return admitted.by === "written" && admitted.kinds.includes("object");
  }
}

/**
 * A typed parse or load whose expected type `Contracts.#answerTask` reads: the node it answers by, where it lands, and
 * whether the level is below a written `object`, where the node is its default's literal data (`#literalOf`).
 */
interface AnsweredCall {
  readonly node: FlowNode;
  readonly call: Expression;
  readonly landing: Landing | null;
  readonly keeps: boolean;
}

/**
 * A typed parse's or load's default, which its value is where it gives one: `null` for a typed one without a default,
 * `undefined` for any other expression.
 */
function typedDefault(node: Expression): Expression | null | undefined {
  if (node.kind === "loadExpression") return node.defaultValue;
  return node.kind === "callExpression" &&
    node.callee.kind === "identifier" &&
    node.callee.name === "fromJson"
    ? defaultOf(node)
    : undefined;
}

/**
 * The literal data one step below `values`, found once per level: a list's or set's elements, and each record field's
 * values by name, the names in the order the records first write them.
 */
interface RecordsBelow {
  readonly elements: readonly Expression[];
  readonly fields: ReadonlyMap<string, readonly Expression[]>;
}

/** No literal data below a level. */
const NO_RECORDS: RecordsBelow = { elements: [], fields: new Map() };

function recordsBelow(
  values: readonly Expression[],
  literalOf: (value: Expression) => Expression | null,
): RecordsBelow {
  const elements: Expression[] = [];
  const fields = new Map<string, Expression[]>();
  // element by element: a literal has as many as its source writes, more than a call takes as arguments
  for (const value of values) {
    const node = literalOf(value);
    if (node === null) continue;
    if (node.kind === "listLiteral" || node.kind === "setLiteral")
      for (const element of node.elements) elements.push(element);
    else if (node.kind === "objectLiteral")
      for (const property of node.properties) {
        const found = fields.get(property.name.name);
        if (found === undefined) fields.set(property.name.name, [property.value]);
        else found.push(property.value);
      }
  }
  return { elements, fields };
}

/**
 * A record's field names in the order its own literal records at this level write them, so that a repair's warnings and
 * a parsed record's fields follow its source; names they do not write follow, as the program first writes them.
 */
function fieldOrder(names: Iterable<string>, below: RecordsBelow, index: SliceIndex): string[] {
  const all = new Set(names);
  return [
    ...[...below.fields.keys()].filter((name) => all.has(name)),
    ...index.inWrittenOrder([...all].filter((name) => !below.fields.has(name))),
  ];
}

/** The `default:` a call's value falls back on, or `null`. */
function defaultOf(call: CallExpression): Expression | null {
  return (
    call.arguments.find(
      (argument) => argument.kind === "namedArgument" && argument.name.name === "default",
    )?.value ?? null
  );
}

/** The kinds whose levels below a typed call's answer its default answers (#1767). */
const STRUCTURED: ReadonlySet<ItemTag> = new Set(["list", "set", "dict", "object", "unknown"]);

/** The exclusion of a typed call's answer a stop left open (#1767). */
const OPEN_BY_STOP = "a typed parse's or load's default that a stop left open";

/**
 * Whether a default reads anything but literal data at any level: a variable, a property or an element of one, any
 * operation but a typed parse or load, or one whose own default does (#1755's test, read after a stop alone and through
 * nested typed calls, #1767). A projection of a literal is the literal data it selects (`projectedLiteral`), where no
 * object literal stands at any level below it: #1460's syntax route proves its items, not an object's names below a
 * projection (Astra r1's B1 and Codex r8–r9 on #1775: `({n: 0}).n`, `[0][i]` and `({p: [load("k", default: 0)]}).p`
 * are literal data, `({p: {n: 0}}).p` and `[{n: 0}][0]` are not).
 */
function readsPlace(fallback: Expression): boolean {
  const pending: { at: Expression; projected: boolean }[] = [{ at: fallback, projected: false }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { at, projected } = next;
    switch (at.kind) {
      case "numberLiteral":
      case "booleanLiteral":
      case "nullLiteral":
        break;
      case "stringLiteral":
        if (at.parts.some((part) => part.kind !== "stringText")) return true;
        break;
      case "parenthesizedExpression":
        pending.push({ at: at.expression, projected });
        break;
      case "listLiteral":
      case "setLiteral":
        for (const element of at.elements) pending.push({ at: element, projected });
        break;
      case "objectLiteral":
        if (projected) return true;
        for (const property of at.properties) pending.push({ at: property.value, projected });
        break;
      case "propertyAccessExpression":
      case "indexExpression": {
        const selected = projectedLiteral(at);
        if (selected === undefined) return true;
        for (const value of selected) pending.push({ at: value, projected: true });
        break;
      }
      // a typed parse or load inside the default answers by its own default, which the outer call reads through,
      // whatever its key (Codex r5's B1, r6's P2)
      case "loadExpression":
        if (at.defaultValue !== null) pending.push({ at: at.defaultValue, projected });
        break;
      case "callExpression": {
        const inner = defaultOf(at);
        if (at.callee.kind !== "identifier" || at.callee.name !== "fromJson" || inner === null)
          return true;
        pending.push({ at: inner, projected });
        break;
      }
      default:
        return true;
    }
  }
  return false;
}

/**
 * What an expression may select through parentheses and projections of literals: an object literal's literal property,
 * or any element of a list literal, whatever the index reads (Codex r9: `[0][load("i", default: 0)]` and
 * `[0][({i: 0}).i]` are elements of `[0]`); a selected part that is itself a projection is followed (Codex r8:
 * `({p: ({n: 0}).n}).p`); an empty list's none. `undefined` where a step leaves the literal's syntax: another receiver,
 * a missing property. Recursive over the syntax alone.
 */
function projectedLiteral(expression: Expression): readonly Expression[] | undefined {
  const at = unwrap(expression);
  if (at.kind !== "propertyAccessExpression" && at.kind !== "indexExpression") return [at];
  const holders = projectedLiteral(at.object);
  if (holders === undefined) return undefined;
  const selected: Expression[] = [];
  for (const holder of holders) {
    let values: readonly (Expression | undefined)[];
    if (at.kind === "propertyAccessExpression")
      values =
        holder.kind === "objectLiteral"
          ? [holder.properties.find((property) => property.name.name === at.property.name)?.value]
          : [undefined];
    // (an element of a list literal at any index, a literal or computed one alike: its elements are of one type)
    else values = holder.kind === "listLiteral" ? holder.elements : [undefined];
    for (const value of values) {
      const parts = value === undefined ? undefined : projectedLiteral(value);
      if (parts === undefined) return undefined;
      selected.push(...parts);
    }
  }
  return selected;
}

/**
 * Whether a stop before admission settled left the value side unproven: a work or depth allowance (A6: the stores
 * admission rejects are unsettled, #1767). A stop after admission settled leaves every finished answer standing, and a
 * decision stopped at its demand allowance leaves its own answers `unknown`, which `stoppedItem` finds.
 */
function stoppedAnalysis(answers: Answers): boolean {
  const { budget } = answers;
  return budget.exhausted !== null && budget.exhausted !== "nesting" && !budget.settled;
}

/** Whether an item is a stop's unknown, what the analysis left unread (#1767). */
function stoppedItem(item: Item): boolean {
  return item.tag === "unknown" && (item.reasons & REASON.budget) !== 0;
}

/**
 * The steps a value adds below its parent where it lands where the parent does (`Contracts.#landing`): none through
 * parentheses, `otherwise` and a `default:`, an element, a property; `null` where it lands nowhere.
 */
function landingStep(
  parent: Expression,
  node: Expression,
  index: SliceIndex,
): readonly string[] | null {
  switch (parent.kind) {
    case "parenthesizedExpression":
      return [];
    case "binaryExpression":
      return parent.operator === "otherwise" ? [] : null;
    case "listLiteral":
    case "setLiteral":
      return ["element"];
    case "objectLiteral": {
      const name = index.propertyOf(node);
      return name === undefined ? null : [propertyStep(name)];
    }
    case "callExpression":
      return lazyDefaultArgument(parent)?.argument.value === node ? [] : null;
    case "loadExpression":
      return parent.defaultValue === node ? [] : null;
    default:
      return null;
  }
}

/**
 * The paths below a value that a plan describes: the value itself, a collection's elements and an object's properties,
 * each structural member of a union's.
 */
function levelsOf(plan: TypePlan): string[][] {
  const levels = new Map<string, string[]>();
  const pending: [TypePlan, string[]][] = [[plan, []]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [at, path] = next;
    if (at.kind === "union") {
      for (const member of at.members) pending.push([member, path]);
      continue;
    }
    levels.set(path.join("\u0000"), path);
    if ((at.kind === "list" || at.kind === "set" || at.kind === "dict") && at.element !== null)
      pending.push([at.element, [...path, "element"]]);
    else if (at.kind === "object")
      for (const property of at.properties)
        pending.push([property.type, [...path, propertyStep(property.name)]]);
  }
  return [...levels.values()];
}

/** A value's contract at a path, and whether each level below it (by its steps) is a written domain. */
interface Provenance {
  readonly contract: TypePlan | null;
  readonly written: (levels: readonly string[]) => boolean;
}

/** Whether a value the core answers may be a collection: one of its kinds is, or it may hold an unknown. */
function bringsCollection(value: ValueAnswer): boolean {
  return value.items.some((item) => item.tag === "unknown" || isCollection(item.tag));
}

/** Whether two plans are one type: the same members, in any order, at every level. */
function samePlan(a: TypePlan, b: TypePlan): boolean {
  const key = (plan: TypePlan): string =>
    plan.kind === "union"
      ? plan.members.map(key).sort().join("|")
      : plan.kind === "list" || plan.kind === "set" || plan.kind === "dict"
        ? `${plan.kind}<${plan.element === null ? "" : key(plan.element)}>`
        : plan.kind === "object"
          ? `{${plan.properties.map((property) => `${property.name}: ${key(property.type)}`).join(", ")}}`
          : plan.kind;
  return key(a) === key(b);
}

/** Whether the core answers a domain as written: its own written type, or one a copy inherits (A4, ADR 0021 1.3). */
function writtenDomain(admitted: AdmittedType): boolean {
  return admitted.by === "written" || (admitted.by === "decided" && admitted.inherited);
}

/**
 * A plan with each whole number a number too (C10's family, ADR 0021 1.2) at each level `widens` says (by its steps below
 * the plan: `element`, a property's step), the levels it does not as they are.
 */
function numberFamily(
  plan: TypePlan,
  widens: (steps: readonly string[]) => boolean,
  steps: readonly string[] = [],
): TypePlan {
  switch (plan.kind) {
    case "integer":
      return widens(steps) ? { kind: "union", members: [plan, { kind: "number" }] } : plan;
    case "union": {
      const members = plan.members.flatMap((member) =>
        membersOf(numberFamily(member, widens, steps)),
      );
      // (one member per kind but the collections and objects, which differ by what is below them)
      const kept = members.filter(
        (member, at) =>
          isCollection(member.kind) ||
          member.kind === "object" ||
          members.findIndex((other) => other.kind === member.kind) === at,
      );
      return unionOf(kept);
    }
    case "list":
    case "set":
    case "dict":
      return plan.element === null
        ? plan
        : {
            kind: plan.kind,
            element: numberFamily(plan.element, widens, joinSteps(steps, ["element"])),
          };
    case "object":
      return {
        ...plan,
        properties: plan.properties.map((property) => ({
          ...property,
          type: numberFamily(
            property.type,
            widens,
            joinSteps(steps, [propertyStep(property.name)]),
          ),
        })),
      };
    default:
      return plan;
  }
}

/** A `get` call's receiver, else `null`. */
function getReceiver(expression: Expression): Expression | null {
  return expression.kind === "callExpression" &&
    expression.callee.kind === "propertyAccessExpression" &&
    expression.callee.property.name === "get"
    ? expression.callee.object
    : null;
}

/** A plan's members: a union's, else the plan itself. */
function membersOf(plan: TypePlan): readonly TypePlan[] {
  return plan.kind === "union" ? plan.members : [plan];
}

/** A plan without its `null`, `null` where nothing else is left. */
function withoutNull(plan: TypePlan): TypePlan | null {
  const members = membersOf(plan).filter((member) => member.kind !== "null");
  return members.length === 0 ? null : unionOf(members);
}

/** Whether a kind is a collection's. */
function isCollection(kind: string): boolean {
  return kind === "list" || kind === "set" || kind === "dict";
}

/** One plan of several: the plan itself, or the union of their members. */
function unionOf(plans: readonly TypePlan[]): TypePlan {
  const members = plans.flatMap((plan) => (plan.kind === "union" ? plan.members : [plan]));
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

/**
 * The diagnostics the compiler reports (#1195): every one but a warning whose expression never runs once its file,
 * function or block runs, as code after an `exit` or the right side of `false and …`, which the warning for code that
 * never runs (TSV065) reports; an error there stays (ADR 0021 rule 1.8). An expression the flow graph has no node for
 * runs with its statement.
 */
export function reportedDiagnostics(answers: Answers): CoreDiagnostic[];
export function reportedDiagnostics(
  answers: Answers,
  diagnostics: readonly CheckedDiagnostic[],
): CheckedDiagnostic[];
export function reportedDiagnostics(
  answers: Answers,
  diagnostics: readonly CheckedDiagnostic[] = answers.diagnostics,
): CheckedDiagnostic[] {
  const { graph } = answers;
  let reached: Set<FlowNode> | null = null;
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.class === "compile-error") return true;
    // the nodes a way over live edges reaches from their region's entry, once
    if (reached === null) {
      reached = new Set(graph.regions.map((region) => region.entry));
      const pending = [...reached];
      for (let node = pending.pop(); node !== undefined; node = pending.pop())
        for (const next of node.successors)
          if (!reached.has(next) && !graph.isDeadEdge(node, next)) {
            reached.add(next);
            pending.push(next);
          }
    }
    const node = graph.expressionAt(diagnostic.site) ?? graph.statementAt(diagnostic.site);
    return node === undefined || reached.has(node);
  });
}

/**
 * The statements that never run once their file runs (S3 §2, group W): those no way over the flow graph's live edges
 * reaches from the file's entry. Every file is asked on its own, whether or not the session enters it.
 */
function unreachable(answers: Answers, index: SliceIndex): Set<Statement> {
  const { graph } = answers;
  const reached = new Set<FlowNode>();
  for (const region of graph.regions)
    if (region.kind === "file") {
      const pending = [region.entry];
      reached.add(region.entry);
      for (let node = pending.pop(); node !== undefined; node = pending.pop())
        for (const next of node.successors)
          if (!reached.has(next) && !graph.isDeadEdge(node, next)) {
            reached.add(next);
            pending.push(next);
          }
    }
  return new Set(
    index.statements.filter((statement) => !reached.has(nodeOf(answers, index, statement))),
  );
}

/** The element type of a collection type: the union of its collection members' elements, `unknown` without one. */
function elementOf(type: StaticType): StaticType {
  const elements = members(type).flatMap((part) =>
    part.kind === "list" || part.kind === "set" || part.kind === "dict" ? [part.element] : [],
  );
  return elements.length === 0 ? UNKNOWN_TYPE : union(elements);
}

/**
 * A written type's term as the type a check takes (V30 §13: an unwritten part and a written `object`'s properties take
 * every value), level by level as written; a compile task, as an annotation's conversion is.
 */
function* termTask(term: TypeTerm): CompileTask<StaticType> {
  switch (term.kind) {
    case "atom":
      return closedType(term.name) ?? UNKNOWN_TYPE;
    case "list":
    case "set":
    case "dict":
      return { kind: term.kind, element: yield* compileChild(termTask(term.element)) };
    case "union": {
      const types: StaticType[] = [];
      for (const member of term.members) types.push(yield* compileChild(termTask(member)));
      return union(types);
    }
    case "object":
    default:
      // (a written `object` is any object; a written term holds no other part, and an open one restricts nothing)
      return term.kind === "object" ? { kind: "object", properties: null } : UNKNOWN_TYPE;
  }
}

/**
 * A place's type at a path: its contract's kinds, and a collection's elements' below it (`levelWalk`); where they nest
 * deeper than the facts follow, the program leaves the slice at `site` (`a.f=[a.f]` failed the compile, #1646).
 */
function placeType(
  answers: Answers,
  id: PlaceId,
  path: readonly string[],
  site: Expression,
): StaticType {
  return factLevels(
    () => levelWalk((at) => answers.place(id, at).contract.kinds.map((item) => item.tag), path),
    site,
  );
}

/**
 * A place's admitted type at a path (A1–A9): per level its written or decided kinds, a place admission never decided its
 * contract's kinds, and a collection's elements' below it (`levelWalk`, `levelProof`); the slice left at `site` as
 * `placeType` leaves it.
 */
function admittedType(
  answers: Answers,
  id: PlaceId,
  path: readonly string[],
  site: Expression,
): StaticType {
  return factLevels(
    () =>
      levelWalk((at) => {
        const place = answers.place(id, at);
        return levelProof(place.admitted, () => place.contract.kinds).tags;
      }, path),
    site,
  );
}

/** A facts walk's type (`levelWalk`), or the program out of the slice at `site` where the walk passed its depth. */
function factLevels(walk: () => (readonly ItemTag[])[], site: Expression): StaticType {
  try {
    return typeOfLevels(walk());
  } catch (error) {
    if (!(error instanceof SliceDepth)) throw error;
    return outsideStructure(site);
  }
}

/** The facts the core settled on for a program inside the slice, by source site (see `SolvedTypeFacts`). */
export function coreFacts(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): SolvedTypeFacts {
  void request;
  // each expression's type after its operands' (the walk's order reversed), so nesting needs no native recursion: the
  // occurrence's kinds, a collection's element type from its literal, its place, or the list its index reads
  const types = new Map<Expression, StaticType>();
  const typeOf = (expression: Expression): StaticType => types.get(expression) ?? UNKNOWN_TYPE;
  for (const expression of [...index.expressions].reverse()) {
    if (expression.kind === "parenthesizedExpression") {
      types.set(expression, typeOf(expression.expression));
      continue;
    }
    const answer = answers.at(nodeOf(answers, index, expression));
    // a read of a place with a written type holds that type: every store into it is checked against it (C1, A1)
    const place = answer?.place ?? null;
    if (place !== null && answers.place(place.id, place.path).admitted.by === "written") {
      types.set(expression, placeType(answers, place.id, place.path, expression));
      continue;
    }
    const tags = answer?.items.map((item) => item.tag) ?? ["unknown"];
    let element: StaticType = UNKNOWN_TYPE;
    if (tags.some((tag) => COLLECTIONS.has(tag)))
      if (expression.kind === "listLiteral")
        element =
          expression.elements.length === 0 ? openType() : union(expression.elements.map(typeOf));
      else if (expression.kind === "indexExpression")
        element = elementOf(elementOf(typeOf(expression.object)));
      else if (place !== null)
        element = placeType(answers, place.id, [...place.path, "element"], expression);
    types.set(expression, typeOfKinds(tags, element));
  }
  const lets = declarations(answers, index);
  const bySite = (a: { readonly site: FactSite }, b: { readonly site: FactSite }): number =>
    a.site.file - b.site.file || a.site.start - b.site.start || a.site.end - b.site.end;
  const bindings = index.lets
    .map((statement) => {
      const place = answers.at(nodeOf(answers, index, statement))?.place ?? null;
      // a binding's type: its written type, else its admitted type (every store into it is checked against it)
      const type =
        statement.typeAnnotation !== null
          ? typeFromAnnotation(statement.typeAnnotation)
          : place === null
            ? UNKNOWN_TYPE
            : admittedType(answers, place.id, place.path, statement.initializer);
      return {
        site: factSite(index.fileOf(statement), statement.span),
        kind: statement.kind,
        name: statement.name.name,
        type: typeKey(type, true, true),
      };
    })
    .sort(bySite);
  const reads = index.reads
    .map((read) => {
      const place = answers.at(nodeOf(answers, index, read))?.place ?? null;
      const declaration = place === null ? undefined : lets.get(place.id);
      return {
        site: factSite(index.fileOf(read), read.span),
        name: read.name,
        binding:
          declaration === undefined ? null : factSite(index.fileOf(declaration), declaration.span),
      };
    })
    .sort(bySite);
  const values = index.expressions
    .map((expression) => ({
      site: factSite(index.fileOf(expression), expression.span),
      kind: expression.kind,
      type: typeKey(typeOf(expression), true, true),
    }))
    .sort((a, b) => bySite(a, b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return {
    bindings,
    values,
    reads,
    functions: [],
    speakers: [],
    uncheckedProperties: [],
    storage: [],
  };
}
