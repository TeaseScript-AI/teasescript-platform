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
  InteractionExpression,
  Program,
  UnitExpression,
  AngleExpression,
  CallArgument,
  FunctionDeclaration,
  FunctionParameter,
  TypeAnnotation,
  GlobalStatement,
} from "../../../ast.js";
import { authorCallee, authorFunctions } from "../slice-syntax.js";
import { type SourceSpan } from "../../../source.js";
import {
  nestedStatements,
  handlerBlocks,
  statementExpressions,
  expressionParts,
  sayOperands,
  askParts,
} from "../../../expression-children.js";
import type { FactSite } from "../../backend.js";
import type { SourceSite, PlaceId } from "../../graph.js";
import { type Answers } from "../answers.js";
import { SLICE_DEPTH } from "../contract-descriptors.js";
import { type FlowNode } from "../flow-graph.js";

/** The store of the slice that brings an expression into its place: a statement, or a transfer. */
export type Store = LetStatement | AssignmentStatement | Transfer;

export type ReturnStatement = Extract<Statement, { kind: "returnStatement" }>;

/**
 * A value stored into a place of a function the script declares: an argument of a call of it, a parameter's default, or
 * a returned value (`definitions.ts`'s argument, parameter default and return definitions).
 */
export type Transfer = CallArgument | FunctionParameter | ReturnStatement;

export function isTransfer(store: Store): store is Transfer {
  return store.kind !== "letStatement" && store.kind !== "assignmentStatement";
}

/**
 * What a store's check reads of the declaration of the place it writes: its kind (a `let`, a `global`, a function's
 * parameter or its result), its name and its written type.
 */
export interface Declaration {
  readonly kind: "letStatement" | "globalStatement" | "functionParameter" | "functionResult";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
}

/** The value a store brings into its place (a parameter or a `return` is a store only with its value, `SliceIndex`). */
export function storedValue(store: Store): Expression {
  switch (store.kind) {
    case "letStatement":
      return store.initializer;
    case "assignmentStatement":
    case "positionalArgument":
    case "namedArgument":
      return store.value;
    case "functionParameter":
      return store.defaultValue!;
    case "returnStatement":
      return store.value!;
  }
}

/**
 * The place a store writes, as the answers name it: a statement's by its flow node (`Answers.storedPlace`), a transfer's,
 * which has no node of its own, where the analysis's definition stores its value (`Answers.transferPlace`); `null`
 * where they name none.
 */
export function storePlace(
  answers: Answers,
  index: SliceIndex,
  store: Store,
): { readonly id: PlaceId; readonly path: readonly string[] } | null {
  if (!isTransfer(store)) return answers.storedPlace(nodeOf(answers, index, store));
  const value = storedValue(store);
  const how =
    store.kind === "functionParameter"
      ? "parameter default"
      : store.kind === "returnStatement"
        ? "return"
        : "argument";
  return (
    answers.transferPlace(index.site(unwrap(value)), how) ??
    answers.transferPlace(index.site(value), how)
  );
}

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
  /** The asks, in source order. */
  readonly asks: InteractionExpression[] = [];
  /** The unit and angle expressions, `n s` and `n deg`, in source order. */
  readonly units: (UnitExpression | AngleExpression)[] = [];
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
  /** The iterables of the `for` loops. */
  readonly #iterables = new Set<Expression>();
  /** The presentations of the `say` statements, whose option names are not written property names. */
  readonly #presentations = new Set<Expression>();
  /** Each argument of a call of a function the script declares: the function, and the parameter it fills, if any. */
  readonly #parameterOf = new Map<
    CallArgument,
    { readonly fn: FunctionDeclaration; readonly parameter: FunctionParameter | undefined }
  >();
  /** The function whose body holds each statement there, and whose list holds each parameter. */
  readonly #functionOf = new Map<Statement | FunctionParameter, FunctionDeclaration>();

  /** `onFile` hears of each file as the walk enters it (S3 §6 keeps the request's progress callback). */
  public constructor(programs: readonly Program[], onFile: (file: number) => void = () => {}) {
    const functionsOf = authorFunctions(programs);
    for (const program of programs)
      for (const fn of program.statements) {
        if (fn.kind !== "functionDeclaration") continue;
        for (const parameter of fn.parameters) this.#functionOf.set(parameter, fn);
        const inner: Statement[] = [...fn.body.statements];
        for (let statement = inner.pop(); statement !== undefined; statement = inner.pop()) {
          this.#functionOf.set(statement, fn);
          inner.push(...nestedStatements(statement));
        }
      }
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
        const { expression, store } = entry;
        if ("parent" in entry && entry.parent !== null) this.#parent.set(expression, entry.parent);
        this.#file.set(expression, file);
        this.expressions.push(expression);
        const key = siteKey(file, expression.span);
        if (!this.#bySite.has(key)) this.#bySite.set(key, expression);
        if (store !== null) this.#store.set(expression, store);
        switch (expression.kind) {
          case "identifier":
            this.reads.push(expression);
            break;
          case "listLiteral":
            this.lists.push(expression);
            for (let at = expression.elements.length - 1; at >= 0; at -= 1)
              pending.push({ expression: expression.elements[at]!, store, parent: expression });
            break;
          case "indexExpression":
            pending.push({ expression: expression.index, store, parent: expression });
            pending.push({ expression: expression.object, store, parent: expression });
            break;
          case "parenthesizedExpression": {
            pending.push({ expression: expression.expression, store, parent: expression });
            break;
          }
          case "objectLiteral":
            for (let at = expression.properties.length - 1; at >= 0; at -= 1) {
              const property = expression.properties[at]!;
              this.#propertyOf.set(property.value, property.name.name);
              // (a presentation's options are no properties of the script's values)
              if (!this.#presentations.has(expression))
                this.#write(property.name.name, file, property.name.span);
              pending.push({ expression: property.value, store, parent: expression });
            }
            break;
          case "propertyAccessExpression":
            this.properties.push(expression);
            pending.push({ expression: expression.object, store, parent: expression });
            break;
          case "binaryExpression":
            // `otherwise`, the slice's one operator with a fallback
            if (expression.operator === "otherwise")
              for (const held of operands(expression.right)) this.#fallbackOf.set(held, expression);
            pending.push({ expression: expression.right, store, parent: expression });
            pending.push({ expression: expression.left, store, parent: expression });
            break;
          case "callExpression": {
            this.calls.push(expression);
            // a call of a function the script declares (as the syntax table reads it, `authorCallee`): each argument a
            // store of its own into the parameter it fills
            const author = authorCallee(expression, functionsOf(file));
            if (author !== undefined) {
              const positional = expression.arguments.filter(
                (argument) => argument.kind === "positionalArgument",
              );
              for (let at = expression.arguments.length - 1; at >= 0; at -= 1) {
                const argument = expression.arguments[at]!;
                const parameter =
                  argument.kind === "namedArgument"
                    ? author.parameters.find((each) => each.name.name === argument.name.name)
                    : author.parameters[positional.indexOf(argument)];
                this.#parameterOf.set(argument, { fn: author, parameter });
                this.#file.set(argument, file);
                pending.push({ expression: argument.value, store: argument });
              }
              break;
            }
            for (const argument of expression.arguments)
              if (argument.kind === "namedArgument" && argument.name.name === "default")
                for (const held of operands(argument.value)) this.#fallbackOf.set(held, expression);
            const method =
              expression.callee.kind === "propertyAccessExpression" ? expression.callee : null;
            const index = expression.arguments[0];
            if (method?.property.name === "get" && index?.kind === "positionalArgument") {
              for (const held of operands(index.value)) this.#getOfIndex.set(held, expression);
            }
            for (let at = expression.arguments.length - 1; at >= 0; at -= 1)
              pending.push({
                expression: expression.arguments[at]!.value,
                store,
                parent: expression,
              });
            if (method !== null)
              pending.push({ expression: method.object, store, parent: expression });
            break;
          }
          case "unitExpression":
          case "angleExpression":
            this.units.push(expression);
            pending.push({ expression: expression.operand, store, parent: expression });
            break;
          case "interactionExpression": {
            this.asks.push(expression);
            // (a question's presentation options are no properties of the script's values)
            if (expression.presentation !== null) this.#presentations.add(expression.presentation);
            const parts = askParts(expression);
            for (let at = parts.length - 1; at >= 0; at -= 1)
              pending.push({ expression: parts[at]!, store, parent: expression });
            break;
          }
          default: {
            // any other expression (outside the slice): its parts, then the statements of the handlers it registers
            for (const block of handlerBlocks(expression))
              pushStatements(pending, block.statements);
            const parts = expressionParts(expression);
            for (let at = parts.length - 1; at >= 0; at -= 1)
              pending.push({ expression: parts[at]!, store, parent: expression });
            break;
          }
          case "loadExpression":
            this.loads.push(expression);
            if (expression.defaultValue !== null) {
              for (const held of operands(expression.defaultValue))
                this.#fallbackOf.set(held, expression);
              pending.push({ expression: expression.defaultValue, store, parent: expression });
            }
            pending.push({ expression: expression.key, store, parent: expression });
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
        pending.push({ expression: statement.initializer, store: statement });
        break;
      case "assignmentStatement":
        pending.push({ expression: statement.value, store: statement });
        // a property store reads its receiver, which a member check at the store reads (C5c)
        if (statement.target.kind === "propertyAccessExpression") {
          // C5 diagnostics name the whole target (§3.4); it is a store, so do not visit it as a read.
          this.#bySite.set(siteKey(file, statement.target.span), statement.target);
          this.#file.set(statement.target, file);
          this.#storeOfReceiver.set(statement.target, statement);
          this.#write(statement.target.property.name, file, statement.target.property.span);
          for (const held of operands(statement.target.object))
            this.#storeOfReceiver.set(held, statement);
          pending.push({ expression: statement.target.object, store: null });
        } else if (statement.target.kind === "indexExpression") {
          // an element store's target is no read either, but a member warning names it, as a property store's (#2807);
          // the store owes no check for it: the runtime's element store checks its receiver and index itself
          const key = siteKey(file, statement.target.span);
          if (!this.#bySite.has(key)) this.#bySite.set(key, statement.target);
          this.#file.set(statement.target, file);
          // an element store reads its receiver and its index
          pending.push({ expression: statement.target.index, store: null });
          pending.push({ expression: statement.target.object, store: null });
        }
        break;
      case "ifStatement":
        if (statement.elseBlock?.kind === "block") statements(statement.elseBlock.statements);
        else if (statement.elseBlock !== null) pending.push({ statement: statement.elseBlock });
        statements(statement.thenBlock.statements);
        pending.push({ expression: statement.condition, store: null });
        break;
      case "repeatStatement":
        statements(statement.body.statements);
        pending.push({ expression: statement.count, store: null });
        break;
      case "sayStatement": {
        // every operand in evaluation order, with what it holds (B1 of #2488's design round): its presentation, its
        // text, which `say` shows, and its pacing
        this.shown.push(statement.value);
        if (statement.presentation !== null) this.#presentations.add(statement.presentation);
        const operands = sayOperands(statement);
        for (let at = operands.length - 1; at >= 0; at -= 1)
          pending.push({ expression: operands[at]!, store: null });
        break;
      }
      case "functionDeclaration":
        // its body, and each parameter's default a store of its own into the parameter
        statements(statement.body.statements);
        for (let at = statement.parameters.length - 1; at >= 0; at -= 1) {
          const parameter = statement.parameters[at]!;
          if (parameter.defaultValue === null) continue;
          this.#file.set(parameter, file);
          pending.push({ expression: parameter.defaultValue, store: parameter });
        }
        break;
      case "returnStatement":
        // the returned value, a store of its own into the function's result
        if (statement.value !== null)
          pending.push({ expression: statement.value, store: statement });
        break;
      case "forStatement":
        this.#iterables.add(statement.iterable);
        statements(statement.body.statements);
        pending.push({ expression: statement.iterable, store: null });
        break;
      default: {
        // any other statement (outside the candidate's slice, `backend.ts`): its blocks and its own expressions
        // in source order, so the checks that read every expression find them (a record of any program)
        const nested = [
          ...nestedStatements(statement),
          ...handlerBlocks(statement).flatMap((block) => block.statements),
        ];
        statements(nested.sort((a, b) => a.span.start.offset - b.span.start.offset));
        const own = [
          ...(statement.kind === "globalStatement" && statement.assignment === null
            ? [statement.initial]
            : []),
          ...statementExpressions(statement),
        ];
        for (let at = own.length - 1; at >= 0; at -= 1)
          pending.push({ expression: own[at]!, store: null });
      }
    }
  }

  /** An argument's function and the parameter it fills (none for an argument no parameter takes). */
  public parameterOf(
    argument: CallArgument,
  ):
    | { readonly fn: FunctionDeclaration; readonly parameter: FunctionParameter | undefined }
    | undefined {
    return this.#parameterOf.get(argument);
  }

  /** The function whose body holds a statement, or whose list holds a parameter; `undefined` outside every one. */
  public functionOf(node: Statement | FunctionParameter): FunctionDeclaration | undefined {
    return this.#functionOf.get(node);
  }

  public fileOf(node: Statement | Expression | CallArgument | FunctionParameter): number {
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
    if (
      statement?.kind === "letStatement" ||
      statement?.kind === "assignmentStatement" ||
      statement?.kind === "returnStatement"
    )
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

  /** Whether `expression` is a `for` loop's iterable. */
  public iterates(expression: Expression): boolean {
    return this.#iterables.has(expression);
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

  public site(node: Statement | Expression | CallArgument | FunctionParameter): SourceSite {
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

/**
 * The kinds of place an assignment of the slice resolves to a declaration (`declarationOf`), tried in order. A case takes
 * the assignment and the place the analysis reads at it, and gives that place's declaration, or `undefined` where the
 * place is not of its kind; a further kind of place is one case more.
 */
const DECLARED: readonly ((
  index: SliceIndex,
  lets: ReadonlyMap<PlaceId, LetStatement>,
  store: AssignmentStatement,
  place: PlaceId,
) => Declaration | undefined)[] = [
  // a variable a `let` of the slice declares
  (_index, lets, _store, place) => lets.get(place),
  // a parameter of the function whose body holds the store, found by the target's name, not by `place`: no name of the
  // body or of its file is a parameter's too (TSV001), so the name is the parameter's place
  (index, _lets, store) => {
    const fn = index.functionOf(store);
    const target = store.target;
    return fn === undefined || target.kind !== "identifier"
      ? undefined
      : fn.parameters.find((parameter) => parameter.name.name === target.name);
  },
  // a `global`, found by the name the target's root reads: a global's name is unique in the project and nothing shadows
  // it (V30, "Global variables")
  (index, _lets, store) => {
    let root: Expression = store.target;
    while (root.kind === "propertyAccessExpression" || root.kind === "indexExpression")
      root = unwrap(root.object);
    if (root.kind !== "identifier") return undefined;
    const { name } = root;
    return index.statements.find(
      (statement): statement is GlobalStatement =>
        statement.kind === "globalStatement" && statement.name.name === name,
    );
  },
];

/** The declaration of the place an assignment writes, by the first case of `DECLARED` that resolves it. */
export function declaredAt(
  index: SliceIndex,
  lets: ReadonlyMap<PlaceId, LetStatement>,
  store: AssignmentStatement,
  place: PlaceId,
): Declaration | undefined {
  for (const declared of DECLARED) {
    const found = declared(index, lets, store, place);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The declaration of the place a store writes: a `let` its own; an assignment's by the place it writes (`DECLARED`). */
export function declarationOf(
  answers: Answers,
  index: SliceIndex,
  lets: ReadonlyMap<PlaceId, LetStatement>,
  store: LetStatement | AssignmentStatement,
): Declaration {
  if (store.kind === "letStatement") return store;
  // (the place the store writes: a compound assignment's node is its operation, which `at` answers with no place)
  const place = storePlace(answers, index, store);
  const declaration = place === null ? undefined : declaredAt(index, lets, store, place.id);
  if (declaration === undefined)
    throw new Error("An assignment of the slice stores into no variable.");
  return declaration;
}

export function unwrap(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

/**
 * A check into a function's parameter or result without a written type: the core's contract there is one over every call
 * and return (F21), not what the function requires of each call (V30 §11), so the slice publishes no check against it
 * (#2667's ruling on untyped places).
 */
export const UNTYPED_FUNCTION_PLACE =
  "a check into a function's parameter or result without a written type";
/** A part check at an argument, a default or a returned value, which lowering has no place for. */
export const PART_CHECK_AT_TRANSFER = "a part check of an argument, a default or a returned value";
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
