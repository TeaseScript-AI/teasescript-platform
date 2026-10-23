import type {
  AssignmentStatement,
  Block,
  CallExpression,
  Expression,
  ForStatement,
  FunctionDeclaration,
  GlobalStatement,
  Identifier,
  InteractionExpression,
  LetStatement,
  Program,
  SpeakerDeclaration,
  Statement,
  TypeAnnotation,
} from "../ast.js";
import { isAskImageCall, isTakePhotoCall } from "../capture-call.js";
import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import { isConversion } from "../conversions.js";
import { changesEntries } from "../dict-operations.js";
import {
  askOperands,
  expressionChildren,
  handlerBlocks,
  mediaOperands,
  namedAskArguments,
  sayOperands,
  showButtonOptions,
  statementExpressions,
  staticText,
  timerOperands,
  unwrap,
} from "../expression-children.js";
import { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "../language-facts.js";
import { lazyDefaultArgument } from "../lazy-defaults.js";
import { isListFunction } from "../list-function-rules.js";
import { listMethod } from "../list-methods.js";
import { isNumericFunction } from "../numeric-functions.js";
import { accountCopy, sessionDeclarations, someNode } from "../project-globals.js";
import { isRandomFunction } from "../random-functions.js";
import type { SourceSpan } from "../source.js";
import { staticChoiceValue, staticVisibleText } from "../static-evaluation.js";
import { PERSON_FIELDS, PLAYER, SPEAKER_NAME_LISTS } from "../speaker-terms.js";
import { isClockFunction } from "../temporal-builtins.js";
import type { ValueKind } from "../value-kinds.js";
import type { TypeAnalysisRequest } from "./backend.js";
import type {
  Constraint,
  ConstraintGraph,
  ContractRef,
  FunctionId,
  FunctionSignature,
  HandlerRegion,
  NamedPlace,
  Origin,
  Place,
  PlaceId,
  PlaceKind,
  ProjectionStep,
  RegionRef,
  Role,
  SourceSite,
  StoreKind,
  SyntaxEvidence,
  TypeTerm,
  ChoiceElementEvidence,
  ChoiceObjectEvidence,
  ChoiceOptionEvidence,
  FormDescriptorEvidence,
  WrittenLiteral,
} from "./graph.js";
import { conditionShape } from "./narrowing-shapes.js";

// The collector of the constraint graph (O4 stage 2): one walk over the project's programs, which emits the places
// and constraints of `graph.ts` and decides nothing. Its order is the legacy check's, except that it walks every
// function body after its file's top level instead of at the first call. It mirrors the visitor's scoping rules to
// resolve names (the legacy facts' `reads` prove it on every source the repository holds); it reads no type and
// reports no diagnostic. The solver (stage 3) decides every type from the graph it makes.

/**
 * Collects the constraint graph of the project of `request`. Names resolve, since the type analysis runs after name
 * checking succeeded; a name that resolves to nothing is a host global, of which the compiler knows nothing.
 */
export function collectGraph(request: TypeAnalysisRequest): ConstraintGraph {
  return new Collector(request).collect();
}

type Entry =
  | {
      readonly kind: "binding";
      readonly place: PlaceId;
      /** The code the binding belongs to, `null` for a global, for the known-value links of its reads. */
      readonly body: object | null;
      /** The initializer a read may count as the variable's value (see `Variable.keeps` of the visitor). */
      readonly keeps: SourceSite | null;
    }
  | { readonly kind: "speaker"; readonly name: string }
  | { readonly kind: "function"; readonly id: FunctionId };

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

  /** The names visible here down to `boundary`, in a new scope under `boundary` (as the visitor's `visibleAbove`). */
  public visibleAbove(boundary: Scope): Scope {
    const copy = new Scope(boundary);
    for (let scope: Scope | null = this; scope !== null && scope !== boundary; scope = scope.parent)
      for (const [name, entry] of scope.#entries)
        if (!copy.#entries.has(name)) copy.#entries.set(name, entry);
    return copy;
  }
}

interface Handler {
  readonly id: number;
  readonly block: Block;
  readonly selfHandle: string | null;
  readonly scope: Scope;
  readonly file: number;
}

/** A node with a span, as the collector sites it. */
interface Spanned {
  readonly span: SourceSpan;
}

const BUILTINS: ReadonlySet<string> = new Set([
  ...CORE_RUNTIME_BUILTINS,
  ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
]);

class Collector {
  readonly #files: readonly { readonly path: string; readonly program: Program }[];
  readonly #programs: readonly Program[];
  readonly #places: Place[] = [];
  readonly #functions: FunctionSignature[] = [];
  readonly #handlerRegions: HandlerRegion[] = [];
  readonly #constraints: Constraint[] = [];
  /** The value place of each visited expression. */
  readonly #values = new Map<Expression, PlaceId>();
  readonly #project = new Scope(null);
  readonly #written: NonNullable<TypeAnalysisRequest["options"]["written"]> | null;
  readonly #speakers: ReadonlyMap<Identifier, string>;
  readonly #builtins: ReadonlySet<string>;
  readonly #handlers: Handler[] = [];
  #region: RegionRef = { kind: "start" };
  /** The name of the `let` whose value is being walked, which a media block binds to its own handle. */
  #selfHandle: string | null = null;
  #file = 0;
  #outer: Scope = this.#project;
  #function: FunctionId | null = null;
  /** The code being walked, in which a `let` counts as kept (see `Variable.keeps` of the visitor). */
  #body: object = this.#project;

  public constructor(request: TypeAnalysisRequest) {
    this.#files = request.files;
    this.#programs = request.files.map((file) => file.program);
    this.#written = request.options.written ?? null;
    this.#speakers = request.options.speakers ?? new Map();
    this.#builtins = new Set([...BUILTINS, ...(request.options.builtins ?? [])]);
    for (const name of request.options.globals ?? []) {
      const place = this.#place(null, name, {
        kind: "binding",
        declared: "host",
        name,
        written: null,
      });
      this.#project.declare(name, { kind: "binding", place, body: null, keeps: null });
    }
  }

  public collect(): ConstraintGraph {
    const programs = this.#programs;
    const functionsByFile = programs.map(() => new Map<FunctionDeclaration, FunctionId>());
    for (const [file, program] of programs.entries())
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration" && statement.global)
          functionsByFile[file]!.set(
            statement,
            this.#declareFunction(statement, file, this.#project),
          );
    const copy = accountCopy(programs);
    const copyFile =
      copy === undefined
        ? -1
        : programs.findIndex((program) => someNode(program, (node) => node === copy));
    for (const { file, declaration } of sessionDeclarations(programs)) {
      this.#file = file;
      this.#outer = this.#project;
      this.#body = this.#project;
      this.#region = { kind: "start" };
      if (declaration.kind === "globalStatement")
        runCompileTask(this.#let(declaration, this.#project));
      else
        runCompileTask(
          this.#speaker(
            declaration,
            copy === undefined ? undefined : { call: copy, file: copyFile },
          ),
        );
    }
    for (const [file, program] of programs.entries()) {
      this.#file = file;
      const root = new Scope(this.#project);
      this.#outer = root;
      const functions = functionsByFile[file]!;
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration" && !statement.global)
          functions.set(statement, this.#declareFunction(statement, file, root));
      this.#body = program;
      this.#region = { kind: "file", file };
      runCompileTask(
        this.#statements(
          program.statements.filter((statement) => statement.kind !== "functionDeclaration"),
          root,
        ),
      );
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration")
          runCompileTask(
            this.#functionBody(
              statement,
              functions.get(statement)!,
              statement.global ? this.#project : root,
            ),
          );
      for (let index = 0; index < this.#handlers.length; index += 1) {
        const handler = this.#handlers[index]!;
        this.#file = handler.file;
        this.#region = { kind: "handler", handler: handler.id };
        const scope = new Scope(handler.scope);
        if (handler.selfHandle !== null) {
          // A block's own handle has no declaration of its own: it is the `let` that holds the media, seen from inside.
          const place = this.#place(null, handler.selfHandle, {
            kind: "binding",
            declared: "let",
            name: handler.selfHandle,
            written: null,
          });
          this.#has(place, { kind: "atom", name: "media" }, handler.block, "initializer");
          scope.declare(handler.selfHandle, { kind: "binding", place, body: handler, keeps: null });
        }
        this.#function = null;
        this.#outer = handler.scope.parent ?? this.#project;
        this.#body = handler;
        runCompileTask(this.#statements(handler.block.statements, scope));
      }
      this.#handlers.length = 0;
    }
    return {
      files: this.#files.map((file) => file.path),
      places: this.#places,
      functions: this.#functions,
      handlers: this.#handlerRegions,
      constraints: this.#constraints,
    };
  }

  // Places and constraints ------------------------------------------------------------------------------------------

  #site(node: Spanned): SourceSite {
    return { file: this.#file, start: node.span.start.offset, end: node.span.end.offset };
  }

  #origin(node: Spanned, role: Role): Origin {
    return { site: this.#site(node), role, region: this.#region };
  }

  #place(node: Spanned | null, label: string, kind: PlaceKind): PlaceId {
    const id = this.#places.length;
    this.#places.push({ id, site: node === null ? null : this.#site(node), label, kind });
    return id;
  }

  /** The value place of an expression occurrence, made when first asked for. */
  #value(expression: Expression, kind: "value" | "target" = "value"): PlaceId {
    const known = this.#values.get(expression);
    if (known !== undefined) return known;
    const place = this.#place(expression, `@${expression.span.start.offset}`, {
      kind,
      node: expression.kind,
    });
    this.#values.set(expression, place);
    return place;
  }

  #add(constraint: Constraint): void {
    this.#constraints.push(constraint);
  }

  /** The place of an expression that was visited, which every operand of an interaction was. */
  #placeOf(expression: Expression): PlaceId {
    const place = this.#values.get(expression);
    if (place === undefined)
      throw new Error("The collector did not visit an expression it cites as evidence.");
    return place;
  }

  #has(place: PlaceId, type: TypeTerm, node: Spanned, role: Role): void {
    this.#add({ ...this.#origin(node, role), kind: "has", place, type });
  }

  #store(value: PlaceId, into: PlaceId, how: StoreKind, node: Spanned, role: Role): void {
    this.#add({ ...this.#origin(node, role), kind: "store", value, into, how });
  }

  #projection(
    owner: PlaceId,
    step: ProjectionStep,
    into: PlaceId,
    node: Spanned,
    role: Role,
  ): void {
    this.#add({ ...this.#origin(node, role), kind: "project", owner, step, into });
  }

  #operation(
    contract: ContractRef,
    receiver: PlaceId | null,
    args: readonly PlaceId[],
    named: readonly NamedPlace[],
    node: Expression,
    role: Role = "operand",
    evidence?: SyntaxEvidence,
  ): PlaceId {
    const result = this.#value(node);
    this.#add({
      ...this.#origin(node, role),
      kind: "operation",
      contract,
      receiver,
      arguments: args,
      named,
      result,
      ...(evidence === undefined ? {} : { evidence }),
    });
    return result;
  }

  /** A compound assignment's operation on the current value and the written one, with the result as a new place. */
  #compound(current: PlaceId, operand: PlaceId, statement: AssignmentStatement): PlaceId {
    const result = this.#place(statement, `@${statement.span.start.offset}`, {
      kind: "value",
      node: "compound",
    });
    this.#add({
      ...this.#origin(statement, "compound assignment"),
      kind: "operation",
      contract: { family: "operator", name: statement.operator.slice(0, 1) },
      receiver: null,
      arguments: [current, operand],
      named: [],
      result,
    });
    return result;
  }

  // Declarations ----------------------------------------------------------------------------------------------------

  #declareFunction(declaration: FunctionDeclaration, file: number, scope: Scope): FunctionId {
    const id = this.#functions.length;
    const previous = this.#file;
    this.#file = file;
    const parameters = declaration.parameters.map((parameter, index) =>
      this.#place(parameter, `${declaration.name.name}.${parameter.name.name}`, {
        kind: "parameter",
        fn: id,
        index,
        name: parameter.name.name,
        written: parameter.typeAnnotation === null ? null : typeTerm(parameter.typeAnnotation),
      }),
    );
    const result = this.#place(declaration.name, `${declaration.name.name}.result`, {
      kind: "result",
      fn: id,
      written:
        declaration.returnTypeAnnotation === null
          ? null
          : typeTerm(declaration.returnTypeAnnotation),
    });
    this.#functions.push({
      id,
      name: declaration.name.name,
      site: this.#site(declaration),
      global: declaration.global,
      parameters,
      result,
    });
    this.#file = previous;
    scope.declare(declaration.name.name, { kind: "function", id });
    return id;
  }

  /** Walks a function's parameter defaults and body, every function once, called or not. */
  *#functionBody(
    declaration: FunctionDeclaration,
    id: FunctionId,
    outer: Scope,
  ): CompileTask<void> {
    const signature = this.#functions[id]!;
    const scope = new Scope(outer);
    const outerBody = this.#body;
    const outerFunction = this.#function;
    const outerScope = this.#outer;
    const outerRegion = this.#region;
    this.#body = declaration;
    this.#outer = outer;
    this.#region = { kind: "function", fn: id };
    for (const [index, parameter] of declaration.parameters.entries()) {
      const place = signature.parameters[index]!;
      // A default runs when the function is called, with the parameters before it in view.
      if (parameter.defaultValue !== null) {
        const value = yield* compileChild(this.#expression(parameter.defaultValue, scope));
        this.#store(value, place, "parameter default", parameter.defaultValue, "parameter default");
      }
      scope.declare(parameter.name.name, {
        kind: "binding",
        place,
        body: declaration,
        keeps: null,
      });
    }
    this.#function = id;
    yield* compileChild(this.#statements(declaration.body.statements, scope));
    // The end of the body: whether it is reached, so that the function completes without a value, is the solver's.
    this.#add({ ...this.#origin(declaration.body, "return"), kind: "exit", fn: id });
    this.#function = outerFunction;
    this.#body = outerBody;
    this.#outer = outerScope;
    this.#region = outerRegion;
  }

  *#let(statement: LetStatement | GlobalStatement, scope: Scope): CompileTask<void> {
    const name = statement.name.name;
    const global = statement.kind === "globalStatement";
    const written = global ? statement.initial : statement.initializer;
    const receiver = statement.typeAnnotation === null ? null : typeTerm(statement.typeAnnotation);
    this.#selfHandle = unwrap(written).kind === "playMediaExpression" ? name : null;
    const value = yield* compileChild(this.#expression(written, scope, receiver));
    this.#selfHandle = null;
    const place = this.#place(statement, name, {
      kind: "binding",
      declared: global ? "global" : "let",
      name,
      written: receiver,
    });
    this.#store(value, place, "initializer", written, global ? "start value" : "initializer");
    // A variable that no code writes keeps its first value, which its reads may count as known.
    const keeps =
      this.#written !== null &&
      !(global ? this.#written.globals.has(name) : this.#written.lets.has(statement));
    scope.declare(name, {
      kind: "binding",
      place,
      body: global ? null : this.#body,
      keeps: keeps ? this.#site(written) : null,
    });
  }

  *#speaker(
    declaration: SpeakerDeclaration,
    copy: { readonly call: CallExpression; readonly file: number } | undefined,
  ): CompileTask<void> {
    const name = declaration.name.name;
    this.#project.declare(name, { kind: "speaker", name });
    // A copy of the account anywhere gives the player each person field from the start, with its terms and name
    // lists as text (V30 §37); the copy itself stores them again where it stands (see `#call`). The seeds are sited
    // at the copy, in its own file.
    if (copy !== undefined && name === PLAYER) {
      const file = this.#file;
      this.#file = copy.file;
      this.#accountFields(copy.call, "start value");
      this.#file = file;
    }
    for (const property of declaration.properties) {
      const value = yield* compileChild(this.#expression(property.value, this.#project));
      this.#add({
        ...this.#origin(property.value, "start value"),
        kind: "speakerStore",
        speaker: name,
        property: property.name.name,
        value,
      });
    }
  }

  /** The person fields that `player.copyFrom(account)` gives the player, each as text or a list of text. */
  #accountFields(copy: CallExpression, role: Role): void {
    for (const field of PERSON_FIELDS) {
      const place = this.#place(copy, `${PLAYER}.${field}`, { kind: "value", node: "copyFrom" });
      this.#has(
        place,
        SPEAKER_NAME_LISTS.has(field)
          ? { kind: "list", element: { kind: "atom", name: "string" } }
          : { kind: "atom", name: "string" },
        copy,
        role,
      );
      this.#add({
        ...this.#origin(copy, role),
        kind: "speakerStore",
        speaker: PLAYER,
        property: field,
        value: place,
      });
    }
  }

  // Statements ------------------------------------------------------------------------------------------------------

  *#statements(statements: readonly Statement[], scope: Scope): CompileTask<void> {
    for (const statement of statements) yield* compileChild(this.#statement(statement, scope));
  }

  *#block(block: Block, scope: Scope): CompileTask<void> {
    yield* compileChild(this.#statements(block.statements, new Scope(scope)));
  }

  *#statement(statement: Statement, scope: Scope): CompileTask<void> {
    switch (statement.kind) {
      case "letStatement":
        yield* compileChild(this.#let(statement, scope));
        return;
      case "globalStatement":
        // The start value was walked with the session's declarations; `default:` assigns where the statement stands.
        if (statement.assignment !== null)
          yield* compileChild(this.#assignment(statement.assignment, scope));
        return;
      case "speakerDeclaration":
      case "speakerSetterStatement":
      case "functionDeclaration":
      case "labelStatement":
      case "breakStatement":
      case "continueStatement":
      case "exitStatement":
      case "endStatement":
        return;
      case "assignmentStatement":
        yield* compileChild(this.#assignment(statement, scope));
        return;
      case "expressionStatement":
        yield* compileChild(this.#expression(statement.expression, scope));
        return;
      case "ifStatement":
        yield* compileChild(this.#expression(statement.condition, scope));
        yield* compileChild(this.#block(statement.thenBlock, scope));
        if (statement.elseBlock === null) return;
        if (statement.elseBlock.kind === "ifStatement")
          yield* compileChild(this.#statement(statement.elseBlock, scope));
        else yield* compileChild(this.#block(statement.elseBlock, scope));
        return;
      case "whileStatement":
        yield* compileChild(this.#expression(statement.condition, scope));
        yield* compileChild(this.#block(statement.body, scope));
        return;
      case "repeatStatement":
        yield* compileChild(this.#expression(statement.count, scope));
        yield* compileChild(this.#block(statement.body, scope));
        return;
      case "forStatement":
        yield* compileChild(this.#loop(statement, scope));
        return;
      case "switchStatement": {
        const subject = yield* compileChild(this.#expression(statement.subject, scope));
        const tested = this.#plainVariable(statement.subject, scope);
        for (const switchCase of statement.cases) {
          if (switchCase.typeTest !== null && tested !== undefined)
            this.#add({
              ...this.#origin(switchCase.typeTest, "condition"),
              kind: "test",
              subject: tested,
              shape: {
                kind: "type",
                type: typeTerm(switchCase.typeTest.type),
                negated: switchCase.typeTest.negated,
              },
              point: { site: this.#site(switchCase.typeTest) },
            });
          for (const value of switchCase.values) {
            const place = yield* compileChild(this.#expression(value, scope));
            // The case's comparison has a result of its own; the case value stays an operand.
            const matched = this.#place(value, `@${value.span.start.offset}`, {
              kind: "value",
              node: "case",
            });
            this.#add({
              ...this.#origin(value, "condition"),
              kind: "operation",
              contract: { family: "comparison", name: "case" },
              receiver: null,
              arguments: [subject, place],
              named: [],
              result: matched,
            });
          }
          yield* compileChild(this.#block(switchCase.body, scope));
        }
        if (statement.defaultBlock !== null)
          yield* compileChild(this.#block(statement.defaultBlock, scope));
        return;
      }
      case "returnStatement": {
        const value =
          statement.value === null
            ? null
            : yield* compileChild(this.#expression(statement.value, scope));
        if (this.#function !== null)
          this.#add({
            ...this.#origin(statement, "return"),
            kind: "return",
            fn: this.#function,
            value,
          });
        return;
      }
      case "saveStatement": {
        const value = yield* compileChild(this.#expression(statement.value, scope));
        yield* compileChild(this.#expression(statement.key, scope));
        this.#add({
          ...this.#origin(statement.value, "saved value"),
          kind: "save",
          key: staticText(statement.key) ?? null,
          value,
        });
        return;
      }
      case "deleteStatement":
        yield* compileChild(this.#expression(statement.key, scope));
        return;
      case "gotoStatement":
      case "callFileStatement":
        if (statement.target.kind === "scriptTarget")
          yield* compileChild(this.#expression(statement.target.expression, scope));
        return;
      default:
        // A command: its operands are evaluated in order, and its blocks run later with the names visible here.
        for (const operand of statementExpressions(statement))
          yield* compileChild(this.#expression(operand, scope));
        this.#pendHandlers(statement, scope);
        return;
    }
  }

  #pendHandlers(
    node: Statement | Expression,
    scope: Scope,
    selfHandle: string | null = null,
  ): void {
    for (const block of handlerBlocks(node)) {
      const id = this.#handlerRegions.length;
      this.#handlerRegions.push({ id, site: this.#site(block), created: this.#region, selfHandle });
      this.#handlers.push({
        id,
        block,
        selfHandle,
        scope: scope.visibleAbove(this.#outer),
        file: this.#file,
      });
    }
  }

  *#loop(statement: ForStatement, scope: Scope): CompileTask<void> {
    const iterable = yield* compileChild(this.#expression(statement.iterable, scope));
    const loopScope = new Scope(scope);
    // The first variable's declaration is the `for` statement, a pair loop's value variable its own name.
    const binding = (name: Identifier, declaration: Spanned): PlaceId => {
      const place = this.#place(declaration, name.name, {
        kind: "binding",
        declared: "loop",
        name: name.name,
        written: null,
      });
      loopScope.declare(name.name, { kind: "binding", place, body: this.#body, keeps: null });
      return place;
    };
    const source = (name: Identifier, step: ProjectionStep): PlaceId => {
      const target = this.#place(name, `${name.name}'s source`, {
        kind: "target",
        node: "forStatement",
      });
      this.#projection(iterable, step, target, statement.iterable, "loop variable");
      return target;
    };
    if (statement.valueVariable === null) {
      // A loop over a list or set copies each element, over a dict each key, over a range each number.
      const target = source(statement.variable, "iteration");
      const place = binding(statement.variable, statement);
      this.#store(target, place, "loop variable", statement.iterable, "loop variable");
    } else {
      const key = binding(statement.variable, statement);
      this.#has(key, { kind: "atom", name: "string" }, statement.iterable, "loop variable");
      const target = source(statement.valueVariable, "entry");
      const value = binding(statement.valueVariable, statement.valueVariable);
      this.#store(target, value, "loop variable", statement.iterable, "loop variable");
    }
    yield* compileChild(this.#statements(statement.body.statements, loopScope));
  }

  *#assignment(statement: AssignmentStatement, scope: Scope): CompileTask<void> {
    const target = statement.target;
    const compound = statement.operator !== "=";
    const role: Role = compound ? "compound assignment" : "assignment";
    if (target.kind === "identifier") {
      const entry = scope.resolve(target.name);
      const binding = entry?.kind === "binding" ? entry.place : undefined;
      const written = binding === undefined ? undefined : this.#places[binding]!.kind;
      const receiver =
        written?.kind === "binding" || written?.kind === "parameter" ? written.written : null;
      let value: PlaceId;
      if (compound) {
        // The current value is read before the written one is evaluated.
        const current = this.#read(target, scope);
        const operand = yield* compileChild(this.#expression(statement.value, scope));
        value = this.#compound(current, operand, statement);
      } else value = yield* compileChild(this.#expression(statement.value, scope, receiver));
      if (binding === undefined) return;
      this.#store(value, binding, compound ? "compound" : "assignment", statement.value, role);
      this.#add({
        ...this.#origin(statement, role),
        kind: "assign",
        binding,
        value,
        point: { site: this.#site(statement) },
      });
      return;
    }
    const speaker = this.#speakerName(target.object, scope);
    if (target.kind === "propertyAccessExpression" && speaker !== undefined) {
      yield* compileChild(this.#expression(target.object, scope));
      let value: PlaceId;
      if (compound) {
        const current = this.#value(target, "target");
        this.#add({
          ...this.#origin(target, "read"),
          kind: "speakerRead",
          speaker,
          property: target.property.name,
          occurrence: current,
        });
        const operand = yield* compileChild(this.#expression(statement.value, scope));
        value = this.#compound(current, operand, statement);
      } else value = yield* compileChild(this.#expression(statement.value, scope));
      this.#add({
        ...this.#origin(statement.value, role),
        kind: "speakerStore",
        speaker,
        property: target.property.name,
        value,
      });
      return;
    }
    // A store through an element or property reaches the place in its owner, and changes the root variable in place.
    const owner = yield* compileChild(this.#expression(target.object, scope));
    const step: ProjectionStep =
      target.kind === "indexExpression" ? "index" : { property: target.property.name };
    if (target.kind === "indexExpression")
      yield* compileChild(this.#expression(target.index, scope));
    const into = this.#value(target, "target");
    this.#projection(owner, step, into, target, role);
    let value: PlaceId;
    if (compound) {
      const operand = yield* compileChild(this.#expression(statement.value, scope));
      value = this.#compound(into, operand, statement);
    } else value = yield* compileChild(this.#expression(statement.value, scope));
    this.#store(
      value,
      into,
      compound ? "compound" : target.kind === "indexExpression" ? "element" : "property",
      statement.value,
      role,
    );
    this.#mutate(target.object, scope, statement);
  }

  /** The root variable that a store through `expression` changes in place, if it is one. */
  #mutate(expression: Expression, scope: Scope, at: Spanned): void {
    let node = unwrap(expression);
    while (node.kind === "propertyAccessExpression" || node.kind === "indexExpression")
      node = unwrap(node.object);
    if (node.kind !== "identifier") return;
    const entry = scope.resolve(node.name);
    if (entry?.kind !== "binding") return;
    this.#add({
      ...this.#origin(at, "assignment"),
      kind: "mutate",
      binding: entry.place,
      point: { site: this.#site(at) },
    });
  }

  /** The binding of a plain variable, for a test that narrows (only a plain variable narrows). */
  #plainVariable(expression: Expression, scope: Scope): PlaceId | undefined {
    const node = unwrap(expression);
    if (node.kind !== "identifier") return undefined;
    const entry = scope.resolve(node.name);
    return entry?.kind === "binding" ? entry.place : undefined;
  }

  /**
   * The declared speaker an expression names: a speaker's name, `speaker` as the name pass resolved it under `as`, or
   * `null` for a `speaker` that may be any.
   */
  #speakerName(expression: Expression, scope: Scope): string | null | undefined {
    const node = unwrap(expression);
    if (node.kind !== "identifier") return undefined;
    const entry = scope.resolve(node.name);
    if (entry?.kind === "speaker") return entry.name;
    if (entry === undefined && node.name === "speaker") return this.#speakers.get(node) ?? null;
    return undefined;
  }

  // Expressions -----------------------------------------------------------------------------------------------------

  /**
   * Walks an expression and returns its value place. `receiver` is the written type of the variable a load starts or
   * is assigned to, which declares the load's key (ADR 0021 §6.2); it reaches only a load that is the value itself.
   */
  *#expression(
    expression: Expression,
    scope: Scope,
    receiver: TypeTerm | null = null,
  ): CompileTask<PlaceId> {
    switch (expression.kind) {
      case "booleanLiteral":
        return this.#literal(expression, "boolean");
      case "nullLiteral":
        return this.#literal(expression, "null");
      case "numberLiteral":
        return this.#literal(
          expression,
          expression.numericType === "integer" ? "integer" : "number",
        );
      case "durationLiteral":
        return this.#literal(expression, expression.calendar ? "calendarDuration" : "duration");
      case "regexLiteral":
        return this.#literal(expression, "regex");
      case "stringLiteral": {
        const place = this.#value(expression);
        for (const part of expression.parts)
          if (part.kind === "stringInterpolation") {
            const shown = yield* compileChild(this.#expression(part.expression, scope));
            this.#add({
              ...this.#origin(part.expression, "operand"),
              kind: "operation",
              contract: { family: "interpolation", name: "show" },
              receiver: null,
              arguments: [shown],
              named: [],
              result: place,
            });
          }
        this.#has(place, { kind: "atom", name: "string" }, expression, "operand");
        return place;
      }
      case "parenthesizedExpression": {
        const inner = yield* compileChild(this.#expression(expression.expression, scope, receiver));
        this.#values.set(expression, inner);
        return inner;
      }
      case "identifier":
        return this.#read(expression, scope);
      case "listLiteral":
      case "setLiteral": {
        const place = this.#value(expression);
        const kind = expression.kind === "listLiteral" ? "list" : "set";
        const cell = this.#place(expression, `${kind}@${expression.span.start.offset}[]`, {
          kind: "cell",
          owner: place,
          step: "element",
        });
        this.#has(place, { kind, element: { kind: "ref", place: cell } }, expression, "operand");
        for (const element of expression.elements) {
          const value = yield* compileChild(this.#expression(element, scope));
          this.#store(value, cell, "element", element, "element");
        }
        return place;
      }
      case "dictLiteral": {
        const place = this.#value(expression);
        const cell = this.#place(expression, `dict@${expression.span.start.offset}{}`, {
          kind: "cell",
          owner: place,
          step: "entry",
        });
        this.#has(
          place,
          { kind: "dict", element: { kind: "ref", place: cell } },
          expression,
          "operand",
        );
        for (const entry of expression.entries) {
          yield* compileChild(this.#expression(entry.key, scope));
          const value = yield* compileChild(this.#expression(entry.value, scope));
          this.#store(value, cell, "entry", entry.value, "entry");
        }
        return place;
      }
      case "objectLiteral": {
        const place = this.#value(expression);
        const properties: { readonly name: string; readonly type: TypeTerm }[] = [];
        for (const property of expression.properties) {
          const value = yield* compileChild(this.#expression(property.value, scope));
          const cell = this.#place(
            property,
            `@${expression.span.start.offset}.${property.name.name}`,
            { kind: "property", owner: place, name: property.name.name },
          );
          this.#store(value, cell, "property", property.value, "property");
          properties.push({ name: property.name.name, type: { kind: "ref", place: cell } });
        }
        this.#has(place, { kind: "object", properties }, expression, "operand");
        return place;
      }
      case "propertyAccessExpression": {
        const name = expression.property.name;
        const speaker = this.#speakerName(expression.object, scope);
        if (speaker !== undefined) {
          yield* compileChild(this.#expression(expression.object, scope));
          const place = this.#value(expression, "target");
          this.#add({
            ...this.#origin(expression, "read"),
            kind: "speakerRead",
            speaker,
            property: name,
            occurrence: place,
          });
          return place;
        }
        const object = unwrap(expression.object);
        if (
          object.kind === "identifier" &&
          object.name === "account" &&
          scope.resolve("account") === undefined
        )
          return this.#operation(
            { family: "speakerField", name: `account.${name}` },
            null,
            [],
            [],
            expression,
            "read",
          );
        const owner = yield* compileChild(this.#expression(expression.object, scope));
        const place = this.#value(expression, "target");
        this.#projection(owner, { property: name }, place, expression, "read");
        return place;
      }
      case "indexExpression": {
        const owner = yield* compileChild(this.#expression(expression.object, scope));
        yield* compileChild(this.#expression(expression.index, scope));
        const place = this.#value(expression, "target");
        this.#projection(owner, "index", place, expression, "read");
        return place;
      }
      case "callExpression":
        return yield* compileChild(this.#call(expression, scope));
      case "unaryExpression": {
        const operand = yield* compileChild(this.#expression(expression.operand, scope));
        return this.#operation(
          { family: expression.operator === "not" ? "logic" : "unary", name: expression.operator },
          null,
          [operand],
          [],
          expression,
        );
      }
      case "binaryExpression":
        return yield* compileChild(this.#binary(expression, scope));
      case "typeTestExpression": {
        const value = yield* compileChild(this.#expression(expression.value, scope));
        // A type test is always the `type` shape; the shape names what it tests, as the visitor reads it.
        const shape = conditionShape(expression);
        const tested = shape.kind === "type" ? this.#plainVariable(shape.tested, scope) : undefined;
        if (tested !== undefined)
          this.#add({
            ...this.#origin(expression, "condition"),
            kind: "test",
            subject: tested,
            shape: { kind: "type", type: typeTerm(expression.type), negated: expression.negated },
            point: { site: this.#site(expression) },
          });
        return this.#operation(
          { family: "typeTest", name: expression.negated ? "is not" : "is" },
          null,
          [value],
          [],
          expression,
        );
      }
      case "rangeExpression": {
        const start = yield* compileChild(this.#expression(expression.start, scope));
        const end = yield* compileChild(this.#expression(expression.end, scope));
        return this.#operation(
          { family: "range", name: expression.inclusive ? "..=" : ".." },
          null,
          [start, end],
          [],
          expression,
        );
      }
      case "unitExpression": {
        const operand = yield* compileChild(this.#expression(expression.operand, scope));
        return this.#operation(
          { family: "unit", name: `${expression.calendar ? "calendar " : ""}${expression.unit}` },
          null,
          [operand],
          [],
          expression,
        );
      }
      case "angleExpression": {
        const operand = yield* compileChild(this.#expression(expression.operand, scope));
        return this.#operation(
          { family: "angle", name: expression.unit },
          null,
          [operand],
          [],
          expression,
        );
      }
      case "loadExpression": {
        yield* compileChild(this.#expression(expression.key, scope));
        const key = staticText(expression.key) ?? null;
        const fallback =
          expression.defaultValue === null
            ? null
            : yield* compileChild(this.#expression(expression.defaultValue, scope));
        const view = this.#place(expression, `load@${expression.span.start.offset}`, {
          kind: "loadView",
          key,
        });
        const result = this.#value(expression);
        this.#add({
          ...this.#origin(expression, "load"),
          kind: "load",
          key,
          view,
          receiver,
          fallback,
          result,
        });
        return result;
      }
      case "interactionExpression":
        return yield* compileChild(this.#interaction(expression, scope));
      case "tagQueryExpression": {
        const operands: PlaceId[] = [];
        for (const operand of expressionChildren(expression))
          operands.push(yield* compileChild(this.#expression(operand, scope)));
        return this.#operation(
          { family: "tagQuery", name: `${expression.catalog}.${expression.select}` },
          null,
          operands,
          [],
          expression,
          "operand",
          { kind: "tagQuery", catalog: expression.catalog, select: expression.select },
        );
      }
      case "sayExpression": {
        const operands: PlaceId[] = [];
        for (const operand of sayOperands(expression))
          operands.push(yield* compileChild(this.#expression(operand, scope)));
        return this.#operation({ family: "say", name: "say" }, null, operands, [], expression);
      }
      case "showButtonExpression": {
        const label = yield* compileChild(this.#expression(expression.label, scope));
        const named: NamedPlace[] = [];
        for (const option of showButtonOptions(expression))
          named.push({
            name: option.name,
            value: yield* compileChild(this.#expression(option.value, scope)),
          });
        return this.#operation(
          { family: "showButton", name: "showButton" },
          null,
          [label],
          named,
          expression,
        );
      }
      case "showPopupExpression": {
        const named: NamedPlace[] = [];
        for (const argument of expression.arguments)
          named.push({
            name: argument.kind === "namedArgument" ? argument.name.name : "",
            value: yield* compileChild(this.#expression(argument.value, scope)),
          });
        return this.#operation({ family: "popup", name: "showPopup" }, null, [], named, expression);
      }
      case "timerExpression": {
        const operands: PlaceId[] = [];
        for (const operand of timerOperands(expression))
          operands.push(yield* compileChild(this.#expression(operand, scope)));
        this.#pendHandlers(expression, scope);
        return this.#operation(
          { family: "timer", name: expression.form },
          null,
          operands,
          [],
          expression,
          "operand",
          { kind: "timer", form: expression.form, async: expression.async },
        );
      }
      case "playMediaExpression": {
        const operands: PlaceId[] = [];
        for (const operand of mediaOperands(expression))
          operands.push(yield* compileChild(this.#expression(operand, scope)));
        this.#pendHandlers(expression, scope, this.#selfHandle);
        return this.#operation(
          { family: "media", name: expression.media },
          null,
          operands,
          [],
          expression,
          "operand",
          { kind: "media", media: expression.media, async: expression.async },
        );
      }
      case "showCameraExpression":
        return this.#operation({ family: "camera", name: "showCamera" }, null, [], [], expression);
      case "showPermanentButtonExpression": {
        const text = yield* compileChild(this.#expression(expression.text, scope));
        this.#pendHandlers(expression, scope);
        return this.#operation(
          { family: "showButton", name: "showPermanentButton" },
          null,
          [text],
          [],
          expression,
        );
      }
    }
  }

  #literal(expression: Expression, name: ValueKind): PlaceId {
    const place = this.#value(expression);
    this.#has(place, { kind: "atom", name }, expression, "operand");
    return place;
  }

  /** A read of a name: a variable's occurrence, a speaker, or a name the compiler knows nothing about. */
  #read(expression: Identifier, scope: Scope): PlaceId {
    const place = this.#value(expression);
    const entry = scope.resolve(expression.name);
    if (entry?.kind === "binding") {
      this.#add({
        ...this.#origin(expression, "read"),
        kind: "read",
        binding: entry.place,
        occurrence: place,
        point: { site: this.#site(expression) },
      });
      if (entry.keeps !== null && (entry.body === null || entry.body === this.#body))
        this.#add({
          ...this.#origin(expression, "read"),
          kind: "knownValue",
          occurrence: place,
          initializer: entry.keeps,
        });
      return place;
    }
    if (entry?.kind === "speaker" || (entry === undefined && expression.name === "speaker")) {
      this.#has(place, { kind: "atom", name: "speaker" }, expression, "read");
      return place;
    }
    if (entry?.kind === "function") return place;
    if (expression.name === "debugMode") {
      this.#has(place, { kind: "atom", name: "boolean" }, expression, "read");
      return place;
    }
    this.#has(place, { kind: "dynamic", why: "host" }, expression, "read");
    return place;
  }

  *#binary(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
    scope: Scope,
  ): CompileTask<PlaceId> {
    if (expression.operator === "otherwise") {
      const left = yield* compileChild(this.#expression(expression.left, scope));
      const right = yield* compileChild(this.#expression(expression.right, scope));
      const result = this.#value(expression);
      this.#add({ ...this.#origin(expression, "operand"), kind: "fallback", left, right, result });
      return result;
    }
    const left = yield* compileChild(this.#expression(expression.left, scope));
    const right = yield* compileChild(this.#expression(expression.right, scope));
    const logic = expression.operator === "and" || expression.operator === "or";
    const comparison = ["==", "!=", "<", "<=", ">", ">="].includes(expression.operator);
    const shape = conditionShape(expression);
    if (shape.kind === "null") {
      // `x == null` and `x != null` narrow a plain variable.
      const tested = this.#plainVariable(shape.tested, scope);
      if (tested !== undefined)
        this.#add({
          ...this.#origin(expression, "condition"),
          kind: "test",
          subject: tested,
          shape: { kind: "null", negated: shape.negated },
          point: { site: this.#site(expression) },
        });
    }
    return this.#operation(
      {
        family: logic ? "logic" : comparison ? "comparison" : "operator",
        name: expression.operator,
      },
      null,
      [left, right],
      [],
      expression,
    );
  }

  *#call(expression: CallExpression, scope: Scope): CompileTask<PlaceId> {
    const callee = unwrap(expression.callee);
    if (isTakePhotoCall(expression)) {
      const args = yield* compileChild(this.#arguments(expression, scope));
      return this.#operation(
        { family: "capture", name: "takePhoto" },
        null,
        args.positional,
        args.named,
        expression,
      );
    }
    if (isAskImageCall(expression)) {
      // The options of the question's mode are evaluated first, as for `say`.
      const presentation: NamedPlace[] =
        expression.presentation === undefined
          ? []
          : [
              {
                name: "presentation",
                value: yield* compileChild(this.#expression(expression.presentation, scope)),
              },
            ];
      const args = yield* compileChild(this.#arguments(expression, scope));
      const allowSkip = expression.arguments.find(
        (argument) => argument.kind === "namedArgument" && argument.name.name === "allowSkip",
      );
      const written = allowSkip === undefined ? undefined : unwrap(allowSkip.value);
      return this.#operation(
        { family: "interaction", name: "askImage" },
        null,
        args.positional,
        [...presentation, ...args.named],
        expression,
        "operand",
        {
          kind: "image",
          allowSkip:
            written === undefined
              ? null
              : written.kind === "booleanLiteral"
                ? written.value
                : "computed",
        },
      );
    }
    if (callee.kind === "identifier") {
      const entry = scope.resolve(callee.name);
      if (entry?.kind === "function") {
        const args = yield* compileChild(this.#arguments(expression, scope));
        const result = this.#value(expression);
        this.#add({
          ...this.#origin(expression, "call"),
          kind: "call",
          fn: entry.id,
          arguments: args.positional,
          named: args.named,
          result,
        });
        return result;
      }
      const args = yield* compileChild(this.#arguments(expression, scope));
      if (entry === undefined && this.#builtins.has(callee.name)) {
        const family = builtinFamily(callee.name);
        return this.#operation(
          { family, name: callee.name },
          null,
          args.positional,
          args.named,
          expression,
          "operand",
          family === "listFunction" || callee.name === "randomWeighted"
            ? selectorsEvidence(expression)
            : undefined,
        );
      }
      const place = this.#value(expression);
      this.#has(place, { kind: "dynamic", why: "unknown callee" }, expression, "call");
      return place;
    }
    if (callee.kind !== "propertyAccessExpression") {
      yield* compileChild(this.#expression(callee, scope));
      yield* compileChild(this.#arguments(expression, scope));
      const place = this.#value(expression);
      this.#has(place, { kind: "dynamic", why: "unknown callee" }, expression, "call");
      return place;
    }
    const method = callee.property.name;
    const speaker = this.#speakerName(callee.object, scope);
    if (method === "copyFrom" && speaker === PLAYER) {
      // `player.copyFrom(account)` stores each person field into the player, as `#speaker` seeds them at the start.
      yield* compileChild(this.#expression(callee.object, scope));
      yield* compileChild(this.#arguments(expression, scope));
      const result = this.#value(expression);
      this.#has(result, { kind: "atom", name: "null" }, expression, "call");
      this.#accountFields(expression, "assignment");
      return result;
    }
    const receiver = yield* compileChild(this.#expression(callee.object, scope));
    const positional = expression.arguments.filter(
      (argument) => argument.kind === "positionalArgument",
    );
    const defaultArgument = expression.arguments.find(
      (argument) => argument.kind === "namedArgument" && argument.name.name === "default",
    );
    if (
      (method === "add" || method === "addAll") &&
      positional.length === 1 &&
      expression.arguments.length === 1
    ) {
      // The element, or each element of the list, is stored into the receiver's elements, in place.
      const value = yield* compileChild(this.#expression(positional[0]!.value, scope));
      const target = this.#place(expression, `${label(callee.object)}[]`, {
        kind: "target",
        node: "callExpression",
      });
      this.#projection(receiver, "element", target, expression, "element");
      const how = method === "add" ? "element" : "elements";
      this.#store(value, target, how, positional[0]!.value, how);
      this.#mutate(callee.object, scope, expression);
      const result = this.#value(expression);
      this.#has(result, { kind: "atom", name: "null" }, expression, "call");
      return result;
    }
    if (
      method === "get" &&
      defaultArgument !== undefined &&
      positional.length === 1 &&
      expression.arguments.length === 2
    ) {
      // The default runs last, only when the call needs it; the result joins the element with it (Q2).
      const key = yield* compileChild(this.#expression(positional[0]!.value, scope));
      const fallback = yield* compileChild(this.#expression(defaultArgument.value, scope));
      const result = this.#value(expression);
      this.#add({
        ...this.#origin(expression, "default"),
        kind: "get",
        receiver,
        key,
        fallback,
        result,
      });
      return result;
    }
    const args = yield* compileChild(this.#arguments(expression, scope));
    if (listMethod(method)?.changes !== undefined || changesEntries(method))
      this.#mutate(callee.object, scope, expression);
    return this.#operation(
      { family: "method", name: method },
      receiver,
      args.positional,
      args.named,
      expression,
    );
  }

  /** The arguments of a call as they are evaluated: positional and named in written order; a lazy `default:` last. */
  *#arguments(
    expression: CallExpression,
    scope: Scope,
  ): CompileTask<{ readonly positional: PlaceId[]; readonly named: NamedPlace[] }> {
    const positional: PlaceId[] = [];
    const named: NamedPlace[] = [];
    // Only a `default:` that runs when the call needs it comes last (see `lazy-defaults.ts`).
    const lazy = lazyDefaultArgument(expression)?.argument;
    const ordered = [
      ...expression.arguments.filter((argument) => argument !== lazy),
      ...(lazy === undefined ? [] : [lazy]),
    ];
    for (const argument of ordered) {
      const value = yield* compileChild(this.#expression(argument.value, scope));
      if (argument.kind === "positionalArgument") positional.push(value);
      else named.push({ name: argument.name.name, value });
    }
    return { positional, named };
  }

  *#interaction(expression: InteractionExpression, scope: Scope): CompileTask<PlaceId> {
    // The options of the question's mode are evaluated first, as for `say`; then the options of `askChoice`, each
    // the value of its expression (a label written before `:` is evidence, not source); then the other operands.
    const named: NamedPlace[] = [];
    if (expression.presentation !== null)
      named.push({
        name: "presentation",
        value: yield* compileChild(this.#expression(expression.presentation, scope)),
      });
    const options: PlaceId[] = [];
    for (const option of expression.options)
      options.push(yield* compileChild(this.#expression(option.expression, scope)));
    for (const operand of askOperands(expression)) {
      if (operand === expression.presentation) continue;
      const argument = namedAskArguments(expression).find(
        (candidate) => candidate.value === operand,
      );
      named.push({
        name:
          argument?.name ??
          (operand === expression.question
            ? "message"
            : operand === expression.hint
              ? "hint"
              : operand === expression.prefill
                ? "prefill"
                : "operand"),
        value: yield* compileChild(this.#expression(operand, scope)),
      });
    }
    return this.#operation(
      { family: "interaction", name: expression.interactionKind },
      null,
      options,
      named,
      expression,
      "operand",
      interactionEvidence(expression, (node) => this.#placeOf(node)),
    );
  }
}

function builtinFamily(name: string): ContractRef["family"] {
  if (isRandomFunction(name)) return "random";
  if (isNumericFunction(name)) return "numeric";
  if (isConversion(name)) return "conversion";
  if (isClockFunction(name)) return "clock";
  if (isListFunction(name)) return "listFunction";
  return "builtin";
}

/** The selectors of a list function or of `randomWeighted`, as text where they are written as text (see `SyntaxEvidence`). */
function selectorsEvidence(expression: CallExpression): SyntaxEvidence {
  const written: { readonly name: string; readonly text: string | null }[] = [];
  for (const argument of expression.arguments)
    if (argument.kind === "namedArgument" && SELECTORS.has(argument.name.name))
      written.push({ name: argument.name.name, text: staticVisibleText(argument.value) ?? null });
  return { kind: "selectors", written };
}

const SELECTORS: ReadonlySet<string> = new Set(["by", "x", "y", "weight"]);

/** The spelling of a receiver for a label, or its site. */
function label(expression: Expression): string {
  // A loop, not a descent: a receiver may be a property path of any length.
  const properties: string[] = [];
  let node = unwrap(expression);
  while (node.kind === "propertyAccessExpression") {
    properties.push(node.property.name);
    node = unwrap(node.object);
  }
  const base = node.kind === "identifier" ? node.name : `@${node.span.start.offset}`;
  return [base, ...properties.reverse()].join(".");
}

/** What the source says about an ask beyond its operands' types (see `SyntaxEvidence`). */
function interactionEvidence(
  expression: InteractionExpression,
  placeOf: (node: Expression) => PlaceId,
): SyntaxEvidence | undefined {
  const argument = (name: string): Expression | undefined =>
    namedAskArguments(expression).find((candidate) => candidate.name === name)?.value;
  const literal = (node: Expression): WrittenLiteral => {
    const known = staticChoiceValue(node);
    return known === undefined ? null : { value: known.value };
  };
  const property = (
    literal: Extract<Expression, { kind: "objectLiteral" }>,
    key: string,
  ): Expression | undefined =>
    literal.properties.find((candidate) => candidate.name.name === key)?.value;
  /** A written choice object's `value` and `text` places. */
  const choiceObject = (
    literal: Extract<Expression, { kind: "objectLiteral" }>,
  ): ChoiceObjectEvidence => {
    const value = property(literal, "value");
    const text = property(literal, "text");
    return {
      value: value === undefined ? null : placeOf(value),
      text: text === undefined ? null : placeOf(text),
    };
  };
  /** The written literal a button returns: the element's, or a written object's `value`, else its `text`. */
  const buttonLiteral = (node: Expression): WrittenLiteral => {
    const content = unwrap(node);
    if (content.kind !== "objectLiteral") return literal(content);
    const returned = property(content, "value") ?? property(content, "text");
    return returned === undefined ? null : literal(returned);
  };
  const element = (node: Expression): ChoiceElementEvidence => {
    const content = unwrap(node);
    return {
      place: placeOf(node),
      literal: buttonLiteral(node),
      object: content.kind === "objectLiteral" ? choiceObject(content) : null,
    };
  };
  const elements = (node: Expression): readonly ChoiceElementEvidence[] | null => {
    const content = unwrap(node);
    return content.kind === "listLiteral" || content.kind === "setLiteral"
      ? content.elements.map(element)
      : null;
  };
  switch (expression.interactionKind) {
    case "form": {
      const fields = argument("fields");
      const container = fields === undefined ? undefined : unwrap(fields);
      const written =
        container?.kind === "objectLiteral"
          ? {
              shape: "object" as const,
              entries: container.properties.map((entry) => ({
                name: entry.name.name,
                value: entry.value,
              })),
            }
          : container?.kind === "dictLiteral"
            ? {
                shape: "dict" as const,
                entries: container.entries.map((entry) => ({
                  name: staticText(entry.key) ?? "?",
                  value: entry.value,
                })),
              }
            : undefined;
      const descriptor = (node: Expression): FormDescriptorEvidence => {
        const content = unwrap(node);
        if (content.kind === "nullLiteral") return { kind: "null" };
        if (content.kind === "listLiteral")
          return { kind: "list", elements: content.elements.map(element) };
        if (content.kind !== "objectLiteral") return { kind: "other" };
        const type = property(content, "type");
        const optional = property(content, "optional");
        const optionalLiteral = optional === undefined ? undefined : unwrap(optional);
        const place = (key: string): PlaceId | null => {
          const found = property(content, key);
          return found === undefined ? null : placeOf(found);
        };
        const options = property(content, "options");
        return {
          kind: "object",
          type: type === undefined ? null : (staticText(type) ?? "computed"),
          optional:
            optional === undefined
              ? null
              : optionalLiteral?.kind === "booleanLiteral"
                ? optionalLiteral.value
                : "computed",
          value: place("value"),
          min: place("min"),
          max: place("max"),
          options:
            options === undefined ? null : { place: placeOf(options), elements: elements(options) },
        };
      };
      const onTimeout = argument("onTimeout");
      return {
        kind: "form",
        fields:
          written === undefined
            ? "computed"
            : {
                shape: written.shape,
                entries: written.entries.map(({ name, value }) => ({
                  name,
                  place: placeOf(value),
                  written: descriptor(value),
                })),
              },
        cancel: argument("cancel") !== undefined,
        timeout: argument("timeout") !== undefined,
        onTimeout: onTimeout === undefined ? null : (staticText(onTimeout) ?? "computed"),
      };
    }
    case "choice":
      return {
        kind: "choice",
        options: expression.options.map((option): ChoiceOptionEvidence => {
          const content = unwrap(option.expression);
          return {
            label:
              option.value === null
                ? null
                : option.value.kind === "identifier"
                  ? { kind: "string", value: option.value.name }
                  : {
                      kind: option.value.numericType === "integer" ? "integer" : "number",
                      value: option.value.value,
                    },
            place: placeOf(option.expression),
            literal: buttonLiteral(option.expression),
            content:
              content.kind === "listLiteral" || content.kind === "setLiteral"
                ? {
                    kind: content.kind === "listLiteral" ? "list" : "set",
                    elements: content.elements.map(element),
                  }
                : content.kind === "objectLiteral"
                  ? { kind: "object", object: choiceObject(content) }
                  : { kind: "other" },
          };
        }),
      };
    case "booleans":
      return { kind: "booleans", cancel: argument("cancel") !== undefined };
    default:
      return undefined;
  }
}

/**
 * The term a written annotation names. A compile task, as the production conversion is (`annotationTask` in
 * `static-types.ts`): an annotation nests as deep as it is written.
 */
function typeTerm(annotation: TypeAnnotation): TypeTerm {
  return runCompileTask(typeTermTask(annotation));
}

function* typeTermTask(annotation: TypeAnnotation): CompileTask<TypeTerm> {
  switch (annotation.kind) {
    case "namedType":
      switch (annotation.name) {
        case "list":
        case "set":
        case "dict":
          return { kind: annotation.name, element: { kind: "dynamic", why: "unwritten parts" } };
        case "object":
          return { kind: "object", properties: null };
        default:
          return { kind: "atom", name: annotation.name };
      }
    case "listType":
    case "setType":
    case "dictType":
      return {
        kind:
          annotation.kind === "listType" ? "list" : annotation.kind === "setType" ? "set" : "dict",
        element: yield* compileChild(typeTermTask(annotation.element)),
      };
    case "optionalType":
      return {
        kind: "union",
        members: [
          yield* compileChild(typeTermTask(annotation.value)),
          { kind: "atom", name: "null" },
        ],
      };
    case "unionType": {
      const members: TypeTerm[] = [];
      for (const member of annotation.members)
        members.push(yield* compileChild(typeTermTask(member)));
      return { kind: "union", members };
    }
  }
}
