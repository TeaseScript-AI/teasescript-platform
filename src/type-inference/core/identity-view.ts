import type {
  CallExpression,
  Expression,
  ForStatement,
  FunctionDeclaration,
  LetStatement,
  ParenthesizedExpression,
  Program,
} from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import type { CoreRuntimeChecks, TypeCheckOptions, TypeCheckResult } from "../backend.js";
import type { CoreAnalysisRequest, CoreFile } from "./program.js";

/*
 * The analysis's view of a project (#2493, docs/specifications/type-inference-accepted-record/contract.md#r4-452):
 * each call of an identity function is read as its argument in parentheses. An identity function has exactly one
 * parameter, with no type and no default, no result type, and a body that is exactly `return` of that parameter.
 * A call is read so only where its callee is a plain name that the project declares as exactly one function, that
 * declaration is an identity function visible from the call's file (global, or the file's own), no parameter or
 * variable of the enclosing function has that name, and the call has one positional argument; every other call stays
 * a call.
 *
 * The view keeps every node of the source that holds no such call and copies the others, a call becoming a
 * parenthesized expression with the call's span. The analysis reads the view; the front end and the plan read the
 * source, so every syntax node that crosses between them is translated: the request's into the view (`identityView`)
 * and the result's back onto the source (`checkedOnSource`). Each member of those types has its translation in a table
 * below, so a member added to one of them does not compile until it has one.
 */

/** A node of the syntax: what the translation maps. */
interface SyntaxNode {
  readonly kind: string;
  readonly span: SourceSpan;
}

/** The analysis's view of a request (see the module's comment). */
export interface IdentityView {
  /** The request as its author wrote it. */
  readonly source: CoreAnalysisRequest;
  /** The request the analysis reads: the view's files, and the options read through the view. */
  readonly request: CoreAnalysisRequest;
  /** How many calls the view reads as their argument. */
  readonly calls: number;
  /** The node of the source that a node of the view stands for: a call for the parentheses that read it. */
  sourceOf<T extends SyntaxNode>(node: T): T;
  /** The node of the view that stands for a node of the source. */
  viewOf<T extends SyntaxNode>(node: T): T;
}

/** One translation of each member of `T` across the view: `on` maps a node to its counterpart on the other side. */
type Translations<T> = { readonly [K in keyof T]-?: (value: T[K], on: Counterpart) => T[K] };
type Counterpart = <N extends SyntaxNode>(node: N) => N;

const kept = <V>(value: V): V => value;
const nodeMap = <K extends SyntaxNode, V>(
  value: ReadonlyMap<K, V>,
  on: Counterpart,
): ReadonlyMap<K, V> => new Map([...value].map(([node, entry]) => [on(node), entry]));
const nodeSet = <K extends SyntaxNode>(value: ReadonlySet<K>, on: Counterpart): ReadonlySet<K> =>
  new Set([...value].map((node) => on(node)));

const OPTIONS_INTO_VIEW: Translations<TypeCheckOptions> = {
  globals: kept,
  builtins: kept,
  imageCatalog: kept,
  capturesTaggedPhotos: kept,
  scriptCatalog: kept,
  sharedWrites: (value, on) => (value === undefined ? value : nodeMap(value, on)),
  written: (value, on) =>
    value === undefined ? value : { ...value, lets: nodeSet<LetStatement>(value.lets, on) },
  speakers: (value, on) => (value === undefined ? value : nodeMap(value, on)),
};

const CORE_CHECKS_ON_SOURCE: Translations<CoreRuntimeChecks> = {
  requireExisting: nodeSet,
  indexChecks: nodeSet,
  fallbackChecks: nodeMap,
  expected: nodeMap,
  repairs: nodeSet,
  partChecks: nodeMap,
};

/** The result's members on the source; `known` asks the view, so it takes the other direction (`viewOf`). */
const RESULT_ON_SOURCE: Translations<Omit<TypeCheckResult, "known">> = {
  diagnostics: kept,
  runtimeChecks: nodeMap,
  formShapes: nodeMap,
  ways: (value, on) => ({ ...value, paths: nodeMap(value.paths, on) }),
  unreachable: nodeSet,
  speakerFlow: kept,
  storageTypes: kept,
  coreChecks: (value, on) =>
    value === undefined ? value : translated(value, CORE_CHECKS_ON_SOURCE, on),
};

/** `value` with each member it holds translated by its entry in `translations`. */
function translated<T extends object>(value: T, translations: Translations<T>, on: Counterpart): T {
  const out: { -readonly [K in keyof T]: T[K] } = { ...value };
  for (const key in translations)
    if (Object.hasOwn(translations, key) && key in out)
      out[key] = translations[key](value[key], on);
  return out;
}

/** The views made, each by the request it was made of and by its own request, so a view is made once. */
const VIEWS = new WeakMap<CoreAnalysisRequest, IdentityView>();

/** The analysis's view of a request (see the module's comment). */
export function identityView(request: CoreAnalysisRequest): IdentityView {
  const known = VIEWS.get(request);
  if (known !== undefined) return known;
  const eligible = identityNames(request.files.map((file) => file.program));
  const back = new Map<SyntaxNode, SyntaxNode>();
  const forth = new Map<SyntaxNode, SyntaxNode>();
  const sourceOf: Counterpart = (node) => counterpart(back, node);
  const viewOf: Counterpart = (node) => counterpart(forth, node);
  let calls = 0;
  const files = request.files.map((file, index): CoreFile => {
    const viewed = viewProgram(file.program, (name) => eligible(name, index), back, forth);
    calls += viewed.calls;
    return viewed.calls === 0
      ? file
      : { ...file, program: viewed.program, picks: nodeMap(file.picks, viewOf) };
  });
  const view: IdentityView = {
    source: request,
    request:
      calls === 0
        ? request
        : { ...request, files, options: translated(request.options, OPTIONS_INTO_VIEW, viewOf) },
    calls,
    sourceOf,
    viewOf,
  };
  VIEWS.set(request, view);
  VIEWS.set(view.request, view);
  return view;
}

/** The analysis's result read back onto the source's nodes (see the module's comment). */
export function checkedOnSource(view: IdentityView, checked: TypeCheckResult): TypeCheckResult {
  if (view.calls === 0) return checked;
  return {
    ...translated<Omit<TypeCheckResult, "known">>(checked, RESULT_ON_SOURCE, view.sourceOf),
    known: (expression) => checked.known(view.viewOf(expression)),
  };
}

/** The other side's node of `node`, or `node` itself where the view keeps it. */
function counterpart<N extends SyntaxNode>(nodes: ReadonlyMap<SyntaxNode, SyntaxNode>, node: N): N {
  // (a copy keeps its node's kind and members; the parentheses that read a call stand where only an expression may)
  // EVIDENCE: invariant: each node's counterpart is its copy, or a call's parentheses in an expression's place.
  return (nodes.get(node) as N | undefined) ?? node;
}

/**
 * Whether a call from a file reads a name as its argument: a name the project declares as exactly one function, an
 * identity function, global or of that file. (A function is declared at a file's top level only: V30 refuses a nested
 * one.)
 */
function identityNames(programs: readonly Program[]): (name: string, file: number) => boolean {
  const declared = new Map<string, FunctionDeclaration[]>();
  const files = new Map<FunctionDeclaration, number>();
  programs.forEach((program, file) => {
    for (const statement of program.statements)
      if (statement.kind === "functionDeclaration") {
        declared.set(statement.name.name, [
          ...(declared.get(statement.name.name) ?? []),
          statement,
        ]);
        files.set(statement, file);
      }
  });
  return (name, file) => {
    const [only, ...more] = declared.get(name) ?? [];
    return (
      only !== undefined &&
      more.length === 0 &&
      isIdentity(only) &&
      (only.global || files.get(only) === file)
    );
  };
}

/** An identity function: one parameter without a type or a default, no result type, a body of `return` of it. */
function isIdentity(declaration: FunctionDeclaration): boolean {
  const parameter = declaration.parameters[0];
  const statement = declaration.body.statements[0];
  return (
    declaration.parameters.length === 1 &&
    parameter !== undefined &&
    parameter.typeAnnotation === null &&
    parameter.defaultValue === null &&
    declaration.returnTypeAnnotation === null &&
    declaration.body.statements.length === 1 &&
    statement !== undefined &&
    statement.kind === "returnStatement" &&
    statement.value?.kind === "identifier" &&
    statement.value.name === parameter.name.name
  );
}

/** Whether the view reads a call as its argument (see the module's comment). */
function readsAsArgument(call: CallExpression, eligible: (name: string) => boolean): boolean {
  const argument = call.arguments[0];
  return (
    call.callee.kind === "identifier" &&
    eligible(call.callee.name) &&
    call.arguments.length === 1 &&
    argument !== undefined &&
    argument.kind === "positionalArgument"
  );
}

/** A value of the tree as the walk meets it: a node, a list of them, or a plain member's value. */
interface Visit {
  readonly value: unknown;
  readonly holder: unknown;
  readonly shadowed: ReadonlySet<string>;
}

/**
 * A program's view: the program itself where it holds no call the view reads, else a copy of each node on the way to
 * one, each such call a parenthesized expression. Iterative, so a deep program does not deepen the native stack.
 */
function viewProgram(
  program: Program,
  eligible: (name: string) => boolean,
  back: Map<SyntaxNode, SyntaxNode>,
  forth: Map<SyntaxNode, SyntaxNode>,
): { readonly program: Program; readonly calls: number } {
  // every container once, before its contents (a tree: each has one holder), and the calls the view reads
  const order: unknown[] = [];
  const holders = new Map<unknown, unknown>();
  const reads = new Set<CallExpression>();
  const stack: Visit[] = [{ value: program, holder: null, shadowed: new Set() }];
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    const { value, holder } = visit;
    if (value === null || typeof value !== "object" || holders.has(value)) continue;
    holders.set(value, holder);
    order.push(value);
    const shadowed = isFunction(value)
      ? new Set([...visit.shadowed, ...ownNames(value)])
      : visit.shadowed;
    if (isCall(value) && readsAsArgument(value, (name) => eligible(name) && !shadowed.has(name)))
      reads.add(value);
    for (const [key, child] of Object.entries(value))
      if (key !== "span") stack.push({ value: child, holder: value, shadowed });
  }
  if (reads.size === 0) return { program, calls: 0 };
  // the containers on the way to a call the view reads, each rebuilt after its contents
  const changed = new Set<unknown>();
  for (const call of reads)
    for (let at: unknown = call; at !== null && !changed.has(at); at = holders.get(at) ?? null)
      changed.add(at);
  // (each changed container's copy; any other value is kept)
  const rebuilt = new Map<unknown, object>();
  for (const value of order.reverse()) {
    if (!changed.has(value)) continue;
    if (isCall(value) && reads.has(value)) {
      const parentheses: ParenthesizedExpression = {
        kind: "parenthesizedExpression",
        expression: viewed(rebuilt.get(value.arguments[0]!.value) ?? value.arguments[0]!.value),
        span: value.span,
      };
      back.set(parentheses, value);
      forth.set(value, parentheses);
      rebuilt.set(value, parentheses);
    } else if (Array.isArray(value))
      rebuilt.set(
        value,
        value.map((child) => rebuilt.get(child) ?? child),
      );
    else if (value !== null && typeof value === "object") {
      const copy = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, rebuilt.get(child) ?? child]),
      );
      if (isNode(value) && isNode(copy)) {
        back.set(copy, value);
        forth.set(value, copy);
      }
      rebuilt.set(value, copy);
    }
  }
  return { program: viewedProgram(rebuilt.get(program)), calls: reads.size };
}

/** The view's copy of an expression. */
function viewed(value: unknown): Expression {
  // EVIDENCE: invariant: an expression's copy keeps its kind and members, or is the parentheses that read a call.
  return value as Expression;
}

/** The view's copy of a program. */
function viewedProgram(value: unknown): Program {
  // EVIDENCE: invariant: a program's copy keeps its kind and members, its calls read as parentheses.
  return value as Program;
}

/** The names a function declares for its body: its parameters, its variables and its loop variables. */
function ownNames(declaration: FunctionDeclaration): readonly string[] {
  const names = declaration.parameters.map((parameter) => parameter.name.name);
  const stack: unknown[] = [declaration.body];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (value === null || typeof value !== "object") continue;
    if (isLet(value)) names.push(value.name.name);
    if (isFor(value)) {
      names.push(value.variable.name);
      if (value.valueVariable !== null) names.push(value.valueVariable.name);
    }
    for (const [key, child] of Object.entries(value)) if (key !== "span") stack.push(child);
  }
  return names;
}

function isNode(value: unknown): value is SyntaxNode {
  return (
    value !== null && typeof value === "object" && "kind" in value && typeof value.kind === "string"
  );
}

function isCall(value: unknown): value is CallExpression {
  return isNode(value) && value.kind === "callExpression";
}

function isFunction(value: unknown): value is FunctionDeclaration {
  return isNode(value) && value.kind === "functionDeclaration";
}

function isLet(value: unknown): value is LetStatement {
  return isNode(value) && value.kind === "letStatement";
}

function isFor(value: unknown): value is ForStatement {
  return isNode(value) && value.kind === "forStatement";
}
