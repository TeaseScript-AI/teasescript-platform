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
import { messageColorDiagnostics } from "../../authored-presentation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "../../diagnostics.js";
import {
  isRepeatCount,
  REPEAT_COUNT_RULE,
  repeatCountFix,
  repeatCountMessage,
} from "../../loop-rules.js";
import type { TypeCheckPlan, TypePlan, TypePropertyPlan } from "../../plan/model.js";
import { compileChild, runCompileTask, type CompileTask } from "../../compiler/continuation.js";
import type { SourceSpan } from "../../source.js";
import { KnownValues } from "../../static-evaluation.js";
import { members, openType, union, UNKNOWN_TYPE, type StaticType } from "../../static-types.js";
import { typeFromAnnotation } from "../../static-types/annotations.js";
import { typeKey } from "../../storage-types.js";
import { typePlan } from "../../type-plans.js";
import { lazyDefaultArgument } from "../../lazy-defaults.js";
import { VALUE_KIND_NAMES, VALUE_KINDS, type ValueKind } from "../../value-kinds.js";
import type {
  CoreRuntimeChecks,
  FactSite,
  RuntimeCheckSite,
  SolvedTypeFacts,
  TypeCheckResult,
} from "../backend.js";
import type { PlaceId, SourceSite } from "../graph.js";
import { closedType, type Answers } from "./answers.js";
import { literalRounds, literalTruth, type FlowNode } from "./flow-graph.js";
import { REASON, type Item, type ItemTag } from "./items.js";
import { propertyName, propertyStep, type CoreAnalysisRequest } from "./program.js";
import type { CoreDiagnostic, Obligation, RequiredKind } from "./result.js";

/*
 * The consumer of the coarse core (the port plan's S5, completed in S9b): one walk over the source with the core's
 * answers, which makes what the compiler consumes, `TypeCheckResult`, and the facts the analysis settled on. Here for
 * the slice `CORE_BACKEND` accepts (`backend.ts`): the core's C1 and C2 diagnostics with their codes, the runtime checks
 * their obligations and C9's boundary checks owe, the ways and the code that never runs from the flow graph's literal
 * facts (P7), the known values, and the kept checks the slice reaches (a `say`'s markup colours, a known repeat
 * count). The slice has no form, speaker property or storage key, so those outputs are empty.
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
                this.#write(statement.target.property.name, file, statement.target.property.span);
                for (const held of operands(statement.target.object))
                  this.#storeOfReceiver.set(held, statement);
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
            // `otherwise`, the slice's one operator
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
    const found = this.#bySite.get(`${site.file}:${site.start}:${site.end}`);
    if (found === undefined)
      throw new Error(`The slice's source has no expression at ${site.file}:${site.start}.`);
    return found;
  }

  /** The `let` or assignment whose stored value holds `expression`, if any. */
  public storeOf(expression: Expression): Store | undefined {
    return this.#store.get(expression);
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

  /** The property store whose target's receiver `expression` is, or holds in parentheses. */
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

  /**
   * Property names in the order the program first writes them, in a literal or as a store's target, so that a record's
   * fields keep the order its source gives them (a repair's warnings, a parsed record's fields); others after them, by
   * name.
   */
  public inWrittenOrder(names: Iterable<string>): string[] {
    const at = (name: string): readonly [number, number] =>
      this.#written.get(name) ?? [Infinity, Infinity];
    return [...names].sort((a, b) => {
      const [fileA, offsetA] = at(a);
      const [fileB, offsetB] = at(b);
      return fileA - fileB || offsetA - offsetB || (a < b ? -1 : a > b ? 1 : 0);
    });
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
 * The flow graph's node of a statement or an expression of the slice: an `if`'s is its condition's and a `repeat`'s its
 * count's, which run first; parentheses have their content's, whose value they are (S3 §3.4: a consumer's site is the
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

/** The kinds of these items as text, for a message: `a number`, `text (string) or null`. */
function kindsText(items: readonly Item[]): string {
  const tags = [...new Set(items.map((item) => item.tag))].filter(
    (tag): tag is Exclude<ItemTag, "unknown" | "empty"> => tag !== "unknown" && tag !== "empty",
  );
  return tags.length === 0
    ? "not one"
    : tags.map((tag) => VALUE_KINDS[tag].description).join(" or ");
}

/**
 * A diagnostic of the core with its code (D3 (a): a runtime-checked warning keeps its rule's code). The sentences are
 * provisional, neutral texts until the owner decides them (D1, S8); the sites are the structured record's (D2).
 */
function diagnosticOf(
  diagnostic: CoreDiagnostic,
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): Diagnostic {
  const expression = index.expressionAt(diagnostic.site);
  const text = request.files[diagnostic.site.file]!.source.slice(
    diagnostic.site.start,
    diagnostic.site.end,
  );
  const severity =
    diagnostic.class === "compile-error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
  // a member of a receiver, which a read or a store needs (C5), is TSV043's rule (D3 (a))
  if (diagnostic.kind === "member-read")
    return createDiagnostic(
      severity,
      "TSV043",
      diagnostic.class === "compile-error"
        ? `'${text}' does not have the property or member that the script uses here.`
        : `The compiler cannot prove that '${text}' has the property or member that the script uses here, so ` +
            "the script checks it when it runs.",
      expression.span,
    );
  // a fallback or a default of another type than the value it stands in for (C10)
  if (
    diagnostic.kind === "written-target" &&
    index.fallbackOf(expression) !== undefined &&
    (diagnostic.class === "compile-error" || diagnostic.obligation.target === text)
  )
    return createDiagnostic(
      severity,
      "TSV041",
      diagnostic.class === "compile-error"
        ? `'${text}' does not fit the type of the value it stands in for.`
        : `The compiler cannot prove that '${text}' fits the type of the value it stands in for, so the script ` +
            "checks it when it runs.",
      expression.span,
    );
  if (diagnostic.kind === "written-target") {
    const store = index.storeOf(expression);
    const name =
      store === undefined
        ? "the place"
        : store.kind === "letStatement"
          ? store.name.name
          : store.target.kind === "identifier"
            ? store.target.name
            : "the place";
    return createDiagnostic(
      severity,
      "TSV041",
      diagnostic.class === "compile-error"
        ? `'${text}' does not fit the type written for '${name}'.`
        : `The compiler cannot prove that '${text}' fits the type written for ` +
            `'${diagnostic.obligation.target}', so the script checks it when it runs.`,
      expression.span,
    );
  }
  // a count is TSV011's rule, a list index TSV043's (D3 (a): each rule's existing code)
  const listIndex = index.roleOf(expression) === "index";
  const rule = listIndex ? "A list index must be a whole number (integer)" : REPEAT_COUNT_RULE;
  return createDiagnostic(
    severity,
    listIndex ? "TSV043" : "TSV011",
    diagnostic.class === "compile-error"
      ? `${rule}, but '${text}' is ${kindsText(
          (answers.at(nodeOf(answers, index, expression))?.items ?? []).filter(
            (item) => item.tag !== "integer",
          ),
        )}.`
      : `${rule}, and the compiler cannot prove that '${text}' is one here, so the script checks it when ` +
          "it runs.",
    expression.span,
  );
}

/** What the compiler consumes of the analysis of a program inside the slice. */
export function coreCheckResult(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): TypeCheckResult {
  const diagnostics: Diagnostic[][] = request.files.map(() => []);
  const sited = new Set<string>();
  for (const diagnostic of answers.diagnostics) {
    if (diagnostic.kind === "operator")
      throw new Error(`The slice has no ${diagnostic.kind} diagnostic.`);
    sited.add(`${diagnostic.site.file}:${diagnostic.site.start}:${diagnostic.site.end}`);
    diagnostics[diagnostic.site.file]!.push(diagnosticOf(diagnostic, answers, index, request));
  }
  const { checks, core } = runtimeChecks(answers, index, request);
  // a `fromJson` reads its JSON as the plan's expected type, so its known value is the one the run gets
  const values = new KnownValues(
    (identifier) => {
      const initializer = answers.initializers.get(
        siteKey(index.fileOf(identifier), identifier.span),
      );
      return initializer === undefined ? undefined : index.expressionAt(initializer);
    },
    (call) => core.expected.get(call),
  );
  const known = (expression: Expression) => values.known(expression);
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
      // the kept check of a known count's value (`loop-rules.ts`), where the core finds the count's kinds fine
      let count: Expression = statement.count;
      while (count.kind === "parenthesizedExpression") count = count.expression;
      if (!sited.has(siteKey(index.fileOf(statement), count.span))) {
        const value = known(statement.count);
        if (typeof value === "number" && !isRepeatCount(value))
          diagnostics[index.fileOf(statement)]!.push(
            createDiagnostic(
              DiagnosticSeverity.Error,
              "TSV011",
              repeatCountMessage("this", String(value), repeatCountFix(value)),
              statement.count.span,
            ),
          );
      }
    } else if (statement.kind === "sayStatement")
      diagnostics[index.fileOf(statement)]!.push(...messageColorDiagnostics(statement.value));
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
    ways: { paths, operands: new Map() },
    unreachable: unreachable(answers, index),
    speakerFlow: { reads: new Map(), stores: new Map() },
    storageTypes: [],
    known,
  };
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
): { checks: Map<RuntimeCheckSite, TypeCheckPlan>; core: CoreRuntimeChecks } {
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
  };
  const owed: Obligation[] = [];
  const fallbacks = new Map<
    BinaryExpression | CallExpression,
    { readonly fallback: Expression; readonly depths: FallbackDepth[] }
  >();
  for (const diagnostic of answers.diagnostics) {
    if (diagnostic.class !== "warning-runtime-check") continue;
    const expression = index.expressionAt(diagnostic.site);
    switch (diagnostic.kind) {
      case "written-target": {
        // C10's obligation names the fallback's own text as its target, with the element steps of a nested literal's
        // depth, C1's a place (S6's departure 6)
        const steps = fallbackSteps(diagnostic.obligation.target, textOf(expression));
        const owner = steps === null ? undefined : index.fallbackOf(expression);
        if (owner === undefined) owed.push(diagnostic.obligation);
        // C10: a load's default is checked as the load's result; any other where it is selected, all its depths at once
        else if (owner.kind !== "loadExpression") {
          const found = fallbacks.get(owner) ?? { fallback: expression, depths: [] };
          found.depths.push({ steps: steps!, against: diagnostic.obligation.against });
          fallbacks.set(owner, found);
        }
        break;
      }
      case "member-read": {
        // C5c: a store whose receiver may lack the property, or not be an object, needs it there
        const store = index.storeOfReceiver(expression);
        if (store !== undefined) core.requireExisting.add(store);
        break;
      }
      case "integer-use": {
        // C2: a list `get` checks its index's kind; a count or an index read is the runtime's own check
        const call = index.getOfIndex(expression);
        if (call !== undefined) core.indexChecks.add(call);
        break;
      }
      case "operator":
        break;
    }
  }
  for (const [owner, { fallback, depths }] of fallbacks) {
    const type = fallbackPlan(fallback, depths, (steps) => contracts.takesNull(owner, steps));
    if (type !== null)
      core.fallbackChecks.set(owner, { type, place: `the value of '${textOf(owner)}'` });
  }
  for (const check of answers.checks) if (check.boundary) owed.push(check);
  // the types a typed load and a `fromJson` read their value as (F18)
  const typed = new Set<Expression>();
  for (const load of index.loads) {
    const type = contracts.expected(load);
    if (type === null) continue;
    typed.add(load);
    checks.set(load, { type, place: `Storage key ${textOf(unwrap(load.key))}` });
    if (type.kind === "object") core.repairs.add(load);
  }
  for (const call of index.calls)
    if (call.callee.kind === "identifier" && call.callee.name === "fromJson") {
      const type = contracts.expected(call);
      if (type === null) continue;
      typed.add(call);
      core.expected.set(call, type);
    }
  for (const obligation of owed) {
    // a boundary check against `unknown` is the runtime's validation of representable external data, which runs for
    // every plan: no plan content (S3 §4)
    if (obligation.against.length === 1 && obligation.against[0] === "unknown") continue;
    const expression = index.expressionAt(obligation.site);
    const store = index.storeOf(expression);
    if (store === undefined) {
      if (obligation.boundary && typed.has(expression)) continue;
      throw new Error("A check of the slice belongs to no store.");
    }
    if (checks.has(store)) continue;
    const type = contracts.stored(store);
    if (type !== null) checks.set(store, type);
  }
  return { checks, core };
}

/** C10's obligation at one depth of a fallback: its element steps below the fallback, and the kinds it requires there. */
interface FallbackDepth {
  readonly steps: readonly string[];
  readonly against: readonly RequiredKind[];
}

/** The element steps of a C10 target below the fallback whose text is `text`, or `null` for another target (a C1's). */
function fallbackSteps(target: string, text: string): string[] | null {
  if (target === text) return [];
  if (!target.startsWith(`${text}.`)) return null;
  const steps = target.slice(text.length + 1).split(".");
  return steps.every((step) => step === "element" || step === "entry") ? steps : null;
}

/**
 * The check of a selected fallback from C10's obligations at its depths (ADR 0021 7.2, nested literals by their
 * elements): at each depth the kinds required there, `null` below the fallback itself where `takesNull` allows it, the
 * collection below it as the fallback's literal is one, else a list or a set for an element and a dict for an entry;
 * `null` where no depth requires a kind.
 */
function fallbackPlan(
  fallback: Expression,
  depths: readonly FallbackDepth[],
  takesNull: (steps: readonly string[]) => boolean,
): TypePlan | null {
  const deepest = Math.max(...depths.map((depth) => depth.steps.length));
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
 * A value whose contract is deeper than the slice follows (`SLICE_DEPTH`): a store's or a typed parse's or load's. The
 * candidate route rejects its program rather than check less than the core decided.
 */
export class UnfollowedStructure extends Error {
  public constructor(readonly expression: Expression) {
    super("The slice does not follow the structure of this value.");
    this.name = "UnfollowedStructure";
  }
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
  readonly #contracts = new Map<string, TypePlan | null>();

  public constructor(
    private readonly answers: Answers,
    private readonly index: SliceIndex,
    private readonly lets: ReadonlyMap<PlaceId, LetStatement>,
  ) {}

  /** The check of a store: the destination's written type, or else its contract at the stored path (A1–A9). */
  public stored(store: Store): TypeCheckPlan | null {
    const declaration = declarationOf(this.answers, this.index, this.lets, store);
    const whole = store.kind === "letStatement" || store.target.kind === "identifier";
    const place = this.answers.at(nodeOf(this.answers, this.index, store))?.place ?? null;
    const type =
      whole && declaration.typeAnnotation !== null
        ? typePlan(typeFromAnnotation(declaration.typeAnnotation))
        : place === null
          ? null
          : runCompileTask(
              this.#contractTask(
                place.id,
                place.path,
                store.kind === "letStatement" ? store.initializer : store.value,
              ),
            );
    if (type === null) return null;
    const name = [
      declaration.name.name,
      ...(whole ? [] : (place?.path ?? []).map(propertyName)),
    ].join(".");
    return { type, place: `'${name}'` };
  }

  /**
   * The type a typed load or `fromJson` reads its value as (F18, S3 §3): the core's own answer at the call, level by
   * level (`#answerTask`); `null` where the call's kinds hold an unknown or only `null` (F19), or a load's key is
   * computed.
   */
  public expected(call: CallExpression | LoadExpression): TypePlan | null {
    if (call.kind === "loadExpression" && unwrap(call.key).kind !== "stringLiteral") return null;
    return runCompileTask(this.#answerTask(nodeOf(this.answers, this.index, call), call, []));
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

  /**
   * A place's contract at a path: its admitted type (`admittedType`) with each object the place decided given the
   * properties the core finds for it (`Answers.placeProperties`), each by its own contract; a written `object` and an
   * undecided one stay open. A contract deeper than the slice follows makes the program, stored by `at`, leave the
   * slice.
   */
  *#contractTask(
    id: PlaceId,
    path: readonly string[],
    at: Expression,
  ): CompileTask<TypePlan | null> {
    const key = `${id}|${path.join(".")}`;
    const known = this.#contracts.get(key);
    if (known !== undefined) return known;
    const admitted = typePlan(admittedType(this.answers, id, path));
    const plan =
      admitted === null ? null : yield* compileChild(this.#fillTask(id, path, admitted, at));
    this.#contracts.set(key, plan);
    return plan;
  }

  *#fillTask(
    id: PlaceId,
    path: readonly string[],
    plan: TypePlan,
    at: Expression,
  ): CompileTask<TypePlan> {
    switch (plan.kind) {
      case "union": {
        const members: TypePlan[] = [];
        for (const member of plan.members)
          members.push(yield* compileChild(this.#fillTask(id, path, member, at)));
        return { kind: "union", members };
      }
      case "list":
      case "set":
      case "dict":
        if (plan.element === null) return plan;
        if (path.length + 1 >= SLICE_DEPTH) throw new UnfollowedStructure(at);
        return {
          kind: plan.kind,
          element: yield* compileChild(this.#fillTask(id, [...path, "element"], plan.element, at)),
        };
      case "object": {
        if (plan.properties.length > 0 || this.answers.place(id, path).admitted.by !== "decided")
          return plan;
        if (path.length + 1 >= SLICE_DEPTH) throw new UnfollowedStructure(at);
        const properties: TypePropertyPlan[] = [];
        for (const name of this.index.inWrittenOrder(this.answers.placeProperties(id, path))) {
          const below = [...path, propertyStep(name)];
          if (this.answers.place(id, below).admitted.by === "undecided") continue;
          const type = yield* compileChild(this.#contractTask(id, below, at));
          if (type !== null) properties.push({ name, type });
        }
        return { kind: "object", properties };
      }
      default:
        return plan;
    }
  }

  /**
   * The core's answer at `path` below a call's value as a plan: its kinds (a written target's, else the default's,
   * F18), integers among numbers as numbers (the decided family, ADR 0021 1.2), a collection's elements and an object's
   * properties below by the same rule. At the call itself an unknown or only `null` gives no plan; below it such a level
   * takes every value (ADR 0021 2.6: `null` leaves a value unknown). A record's field that some of its sources lack
   * (`missing`) has the kinds the others give, and a missing one is the default's; inside a collection, where no default
   * supplies it, and deeper than the slice follows, the program leaves the slice.
   */
  *#answerTask(
    node: FlowNode,
    call: Expression,
    path: readonly string[],
  ): CompileTask<TypePlan | null> {
    const answer = this.answers.valueAt(node, path);
    const held = new Set<ItemTag>();
    let lacking = false;
    for (const item of answer.items)
      if (item.tag === "unknown" && item.reasons === REASON.missing) lacking = true;
      else if (item.tag !== "empty") held.add(item.tag);
    if (held.has("number")) held.delete("integer");
    if (held.has("unknown") || ![...held].some((tag) => tag !== "null"))
      return path.length === 0 ? null : ANY_VALUE;
    if (path.length + 1 >= SLICE_DEPTH || (lacking && path.includes("element")))
      throw new UnfollowedStructure(call);
    const members: TypePlan[] = [];
    for (const tag of VALUE_KIND_NAMES.filter((kind) => held.has(kind)))
      if (tag === "list" || tag === "set" || tag === "dict") {
        const element = yield* compileChild(this.#answerTask(node, call, [...path, "element"]));
        // elements that take every value leave the collection open, as a store's check has it
        members.push({ kind: tag, element: element === ANY_VALUE ? null : element });
      } else if (tag === "object") {
        const properties: TypePropertyPlan[] = [];
        for (const name of this.index.inWrittenOrder(answer.properties))
          properties.push({
            name,
            // EVIDENCE: invariant: below the call a level always has a plan (`ANY_VALUE` at the least).
            type: (yield* compileChild(
              this.#answerTask(node, call, [...path, propertyStep(name)]),
            ))!,
          });
        members.push({ kind: "object", properties });
      } else members.push(kindPlan(tag));
    return unionOf(members);
  }
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

/** One plan of several: the plan itself, or the union of their members. */
function unionOf(plans: readonly TypePlan[]): TypePlan {
  const members = plans.flatMap((plan) => (plan.kind === "union" ? plan.members : [plan]));
  return members.length === 1 ? members[0]! : { kind: "union", members };
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

/**
 * A type of these kinds for the facts: each kind's closed type (`closedType`), a collection's with `element` as its
 * element type; no kind is `?`. The slice's variables hold one kind or one numeric family, so one element type serves.
 */
function typeOfKinds(tags: readonly ItemTag[], element: StaticType): StaticType {
  const kinds = [...new Set(tags)].filter((tag) => tag !== "empty");
  if (kinds.length === 0) return openType();
  return union(
    kinds.map((tag): StaticType =>
      tag === "list" || tag === "set" || tag === "dict"
        ? { kind: tag, element }
        : (closedType(tag) ?? UNKNOWN_TYPE),
    ),
  );
}

/** The element type of a collection type: the union of its collection members' elements, `unknown` without one. */
function elementOf(type: StaticType): StaticType {
  const elements = members(type).flatMap((part) =>
    part.kind === "list" || part.kind === "set" || part.kind === "dict" ? [part.element] : [],
  );
  return elements.length === 0 ? UNKNOWN_TYPE : union(elements);
}

const COLLECTIONS: ReadonlySet<ItemTag> = new Set(["list", "set", "dict"]);

/**
 * The deepest nesting of collections whose element types the slice's facts follow: a place or a written type with a
 * collection at this depth is outside the slice (`backend.ts` rejects it), so no fact is cut short.
 */
export const SLICE_DEPTH = 256;

/** A place's type at a path: its contract's kinds, and a collection's elements' below it, built from the deepest up. */
function placeType(answers: Answers, id: PlaceId, path: readonly string[]): StaticType {
  const levels: ItemTag[][] = [];
  for (let at = [...path]; ; at = [...at, "element"]) {
    const tags = answers.place(id, at).contract.kinds.map((item) => item.tag);
    levels.push(tags);
    if (!tags.some((tag) => COLLECTIONS.has(tag))) break;
    if (at.length + 1 >= SLICE_DEPTH)
      throw new Error("A place of the slice holds collections deeper than its facts follow.");
  }
  let type: StaticType = openType();
  for (let depth = levels.length - 1; depth >= 0; depth -= 1)
    type = typeOfKinds(levels[depth]!, type);
  return type;
}

/**
 * A place's admitted type at a path (A1–A9): per level its written or decided kinds, a place admission never decided its
 * contract's kinds, and a collection's elements' below it, built from the deepest up.
 */
function admittedType(answers: Answers, id: PlaceId, path: readonly string[]): StaticType {
  const levels: ItemTag[][] = [];
  for (let at = [...path]; ; at = [...at, "element"]) {
    const place = answers.place(id, at);
    const tags =
      place.admitted.by === "undecided"
        ? place.contract.kinds.map((item) => item.tag)
        : [...place.admitted.kinds];
    levels.push(tags);
    if (!tags.some((tag) => COLLECTIONS.has(tag))) break;
    if (at.length + 1 >= SLICE_DEPTH)
      throw new Error("A place of the slice holds collections deeper than its facts follow.");
  }
  let type: StaticType = openType();
  for (let depth = levels.length - 1; depth >= 0; depth -= 1)
    type = typeOfKinds(levels[depth]!, type);
  return type;
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
      types.set(expression, placeType(answers, place.id, place.path));
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
      else if (place !== null) element = placeType(answers, place.id, [...place.path, "element"]);
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
            : admittedType(answers, place.id, place.path);
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
