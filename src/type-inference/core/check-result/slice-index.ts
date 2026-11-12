// The candidate's slice of the source: its statements, expressions and spans by site (`SliceIndex`), and its refusal of
// a construct outside it (`OutsideContract`).
import type {
  LetStatement,
  AssignmentStatement,
  Expression,
  Statement,
  ListLiteral,
  Identifier,
  PropertyAccessExpression,
  CallExpression,
  LoadExpression,
  BinaryExpression,
  Program,
} from "../../../ast.js";
import { type SourceSpan } from "../../../source.js";
import {
  nestedStatements,
  handlerBlocks,
  statementExpressions,
  expressionParts,
  sayOperands,
} from "../../../expression-children.js";
import type { FactSite } from "../../backend.js";
import type { SourceSite, PlaceId } from "../../graph.js";
import { type Answers } from "../answers.js";
import { SLICE_DEPTH } from "../contract-descriptors.js";
import { type FlowNode } from "../flow-graph.js";

/** The store statement of the slice that brings an expression into its place. */
export type Store = LetStatement | AssignmentStatement;

export function siteKey(file: number, span: SourceSpan): string {
  return `${file}:${span.start.offset}:${span.end.offset}`;
}

export function factSite(file: number, span: SourceSpan): FactSite {
  return { file, start: span.start.offset, end: span.end.offset };
}

/** An operand and the expressions it holds in parentheses, outermost first. */
function operands(expression: Expression): Expression[] {
  const found = [expression];
  for (let at = expression; at.kind === "parenthesizedExpression"; at = at.expression)
    found.push(at.expression);
  return found;
}

/** An item of the slice's walk: a statement, or an expression with the store it belongs to. */
type Entry =
  | { readonly statement: Statement }
  | {
      readonly expression: Expression;
      readonly store: Store | null;
      readonly whole: boolean;
      readonly parent?: Expression | null;
    };

/** Pushes a statement list onto the walk's stack, last first, so it is walked in source order. */
function pushStatements(pending: Entry[], list: readonly Statement[]): void {
  for (let at = list.length - 1; at >= 0; at -= 1) pending.push({ statement: list[at]! });
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
  /** The presentations of the `say` statements, whose option names are not written property names. */
  readonly #presentations = new Set<Expression>();

  /** `onFile` hears of each file as the walk enters it (S3 §6 keeps the request's progress callback). */
  public constructor(programs: readonly Program[], onFile: (file: number) => void = () => {}) {
    programs.forEach((program, file) => {
      onFile(file);
      const pending: Entry[] = program.statements.map((statement) => ({ statement })).reverse();
      for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
        if ("statement" in entry) {
          const statement = entry.statement;
          this.#file.set(statement, file);
          this.statements.push(statement);
          const key = siteKey(file, statement.span);
          if (!this.#statementsBySite.has(key)) this.#statementsBySite.set(key, statement);
          this.#statement(statement, pending);
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
              // (a presentation's options are no properties of the script's values)
              if (!this.#presentations.has(expression))
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
            for (const block of handlerBlocks(expression))
              pushStatements(pending, block.statements);
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

  /** A statement's own work in the walk: what it records, and its expressions and nested statements pushed to `pending`. */
  #statement(statement: Statement, pending: Entry[]): void {
    const statements = (list: readonly Statement[]): void => pushStatements(pending, list);
    const file = this.fileOf(statement);
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
        else if (statement.elseBlock !== null) pending.push({ statement: statement.elseBlock });
        statements(statement.thenBlock.statements);
        pending.push({ expression: statement.condition, store: null, whole: false });
        break;
      case "repeatStatement":
        statements(statement.body.statements);
        this.#role.set(statement.count, "count");
        pending.push({ expression: statement.count, store: null, whole: false });
        break;
      case "sayStatement": {
        // every operand in evaluation order, with what it holds (B1 of #2488's design round): its presentation, its
        // text, which `say` shows, and its pacing
        this.shown.push(statement.value);
        if (statement.presentation !== null) this.#presentations.add(statement.presentation);
        const operands = sayOperands(statement);
        for (let at = operands.length - 1; at >= 0; at -= 1)
          pending.push({ expression: operands[at]!, store: null, whole: false });
        break;
      }
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
export function declarations(answers: Answers, index: SliceIndex): Map<PlaceId, LetStatement> {
  const found = new Map<PlaceId, LetStatement>();
  for (const statement of index.lets) {
    const place = answers.at(nodeOf(answers, index, statement))?.place;
    if (place !== null && place !== undefined) found.set(place.id, statement);
  }
  return found;
}

/** The variable a store writes: its declaration, through the place the analysis reads at the store. */
export function declarationOf(
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

export function unwrap(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

/** A typed parse's or load's default whose level a stop left unproven (#1767). */
export const OPEN_BY_STOP = "a typed parse's or load's default that a stop left open";
/** After a settled stop, obligations the analysis cannot find (`lostCheck`). */
export const UNESTABLISHED_AT_BUDGET =
  "a store whose required checks could not be established at the budget";
/** After a settled stop, a required check the published plan does not keep (`lostCheck`). */
export const LOST_AT_BUDGET = "a store whose check was lost at the budget";
/** After a stop before admission settled, an owed obligation against `unknown` (#2080). */
export const UNDECIDED_AT_BUDGET = "a store whose check was left undecided at the budget";
/** After a settled stop, a fallback's obligation against `unknown`: its check the plan cannot make (#2183). */
export const DEFAULT_LOST_AT_BUDGET = "a default whose check was lost at the budget";

/**
 * The reasons the stop's gates (`lostCheck`) and rule (R) (`OPEN_BY_STOP`) decline with (#2080, the owner's go,
 * 2026-11-10): tests count them by `limit`, which reads this list, so no site marks one without its reason. A refusal the
 * slice makes from a diagnostic or a contract a stop shaped carries its coverage reason and is not here: nothing at its
 * site tells it from the same refusal without a stop (#2236).
 */
export const LIMIT_REASONS: readonly string[] = [
  OPEN_BY_STOP,
  UNESTABLISHED_AT_BUDGET,
  LOST_AT_BUDGET,
  UNDECIDED_AT_BUDGET,
  DEFAULT_LOST_AT_BUDGET,
];

/**
 * A contract the plan cannot carry exactly as the core decided it: one deeper than the slice follows (`SLICE_DEPTH`), a
 * record field that some records of a list lack, a typed parse or load into a copy of a written type, a typed parse's or
 * load's default a stop left open (#1767). The candidate route rejects its program, at `expression`, rather than check
 * less than the core decided.
 */
export class OutsideContract extends Error {
  /** Whether its reason is one the stop's gates or rule (R) decline with (`LIMIT_REASONS`). */
  readonly limit: boolean;
  public constructor(
    readonly expression: Expression,
    readonly what: string,
  ) {
    super(`The slice does not follow ${what}.`);
    this.name = "OutsideContract";
    this.limit = LIMIT_REASONS.includes(what);
  }
}

// (the backend's slice rule reads the facts' depth here, where it read it before the service had it)
export { SLICE_DEPTH };

/** A value whose contract is deeper than the slice follows (`SLICE_DEPTH`): the program leaves the slice at it. */
export function outsideStructure(at: Expression): never {
  throw new OutsideContract(at, "a value whose structure the slice does not follow");
}
