import type {
  CallExpression,
  Expression,
  ForStatement,
  FunctionDeclaration,
  LetStatement,
  ParenthesizedExpression,
  Program,
  Statement,
} from "../../ast.js";
import { changesEntries } from "../../dict-operations.js";
import { unwrap } from "../../expression-children.js";
import { listMethod } from "../../list-methods.js";
import type { SourceSpan } from "../../source.js";
import type { CoreRuntimeChecks, TypeCheckOptions, TypeCheckResult } from "../backend.js";
import type { WorkLedger } from "./budget.js";
import type { CoreAnalysisRequest, CoreFile } from "./program.js";

/*
 * The analysis's view of a project (#2493, docs/specifications/type-inference-accepted-record/contract.md#r4-452):
 * each call of an identity function is read as its argument in parentheses. An identity function has exactly one
 * parameter, with no type and no default, no result type, and a body that is exactly `return` of that parameter.
 * A call is read so only where its callee is a plain name that the project declares as exactly one function, that
 * declaration is an identity function visible from the call's file (global, or the file's own), no parameter or
 * variable of the enclosing function has that name, the call has one positional argument, and it stands in no place
 * slot; every other call stays a call. A place slot is where a write through parentheses reaches the place they hold
 * (`placeSlots`): there the call's result is a copy of its argument, so the call stays one.
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
  /** The units of work the view took (`identitySteps`, `viewProgram`'s list): none without an identity function. */
  readonly steps: number;
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
  const names = identityNames(request.files);
  if (names === null) {
    const none: IdentityView = {
      source: request,
      request,
      calls: 0,
      steps: 0,
      sourceOf: kept,
      viewOf: kept,
    };
    VIEWS.set(request, none);
    return none;
  }
  // (the declarations' scan; then a unit per file, each file's walk, and a unit per node translated into the view)
  let steps = names.steps;
  const back = new Map<SyntaxNode, SyntaxNode>();
  const forth = new Map<SyntaxNode, SyntaxNode>();
  const sourceOf: Counterpart = (node) => counterpart(back, node);
  const viewOf: Counterpart = (node) => counterpart(forth, node);
  const into: Counterpart = (node) => {
    steps += 1;
    return viewOf(node);
  };
  let calls = 0;
  const files = request.files.map((file, index): CoreFile => {
    steps += 1;
    const viewed = viewProgram(file.program, (name) => names.eligible(name, index), back, forth);
    calls += viewed.calls;
    steps += viewed.steps;
    return viewed.calls === 0
      ? file
      : { ...file, program: viewed.program, picks: nodeMap(file.picks, into) };
  });
  const view: IdentityView = {
    source: request,
    request:
      calls === 0
        ? request
        : { ...request, files, options: translated(request.options, OPTIONS_INTO_VIEW, into) },
    calls,
    steps,
    sourceOf,
    viewOf,
  };
  VIEWS.set(request, view);
  VIEWS.set(view.request, view);
  return view;
}

/**
 * The analysis's result read back onto the source's nodes (see the module's comment), a unit of `identitySteps` per
 * node translated charged to `work`.
 */
export function checkedOnSource(
  view: IdentityView,
  checked: TypeCheckResult,
  work: WorkLedger,
): TypeCheckResult {
  if (view.calls === 0) return checked;
  let steps = 0;
  const onSource: Counterpart = (node) => {
    steps += 1;
    return view.sourceOf(node);
  };
  const result = translated<Omit<TypeCheckResult, "known">>(checked, RESULT_ON_SOURCE, onSource);
  if (steps > 0) work.charge("identitySteps", steps);
  // (`known` asks one node per question, a lookup)
  return { ...result, known: (expression) => checked.known(view.viewOf(expression)) };
}

/** The other side's node of `node`, or `node` itself where the view keeps it. */
function counterpart<N extends SyntaxNode>(nodes: ReadonlyMap<SyntaxNode, SyntaxNode>, node: N): N {
  // (a copy keeps its node's kind and members; the parentheses that read a call stand where only an expression may)
  // EVIDENCE: invariant: each node's counterpart is its copy, or a call's parentheses in an expression's place.
  return (nodes.get(node) as N | undefined) ?? node;
}

/**
 * Whether a call from a file reads a name as its argument: a name the project declares as exactly one function, an
 * identity function, global or of that file; `null` where it declares none, whose scan is charged nothing (so a source
 * without one keeps its work). With the units of its scan: a unit per file, per top-level statement and per function
 * name declared. (A function is declared at a file's top level only: V30 refuses a nested one.)
 */
function identityNames(
  files: readonly CoreFile[],
): { readonly eligible: (name: string, file: number) => boolean; readonly steps: number } | null {
  const declared = new Map<string, { declaration: FunctionDeclaration; file: number }[]>();
  let steps = 0;
  files.forEach(({ program }, file) => {
    steps += 1;
    for (const statement of program.statements) {
      steps += 1;
      if (statement.kind === "functionDeclaration") {
        const same = declared.get(statement.name.name);
        if (same === undefined)
          declared.set(statement.name.name, [{ declaration: statement, file }]);
        else same.push({ declaration: statement, file });
      }
    }
  });
  // each name decided once: declared exactly once, as an identity function
  const identities = new Map<string, { declaration: FunctionDeclaration; file: number }>();
  for (const [name, same] of declared) {
    steps += 1;
    const only = same[0];
    if (same.length === 1 && only !== undefined && isIdentity(only.declaration))
      identities.set(name, only);
  }
  if (identities.size === 0) return null;
  return {
    eligible: (name, file) => {
      const only = identities.get(name);
      return only !== undefined && (only.declaration.global || only.file === file);
    },
    steps,
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
 *
 * Its units of work (`identitySteps`), one for each turn of each loop, so the allowance bounds all the work the view
 * does. Together with `identityView`'s (a unit per file and per node translated into the view, and `identityNames`' a
 * unit per file, per top-level statement and per function name) and `checkedOnSource`'s (a unit per node translated
 * back), these are every loop of the view:
 * - the walk: a unit per value met (a node, a list, a member's value, `null`);
 * - at a function, `ownNames`: a unit per parameter and per value of its body met; and the copy of the names it inherits with its own
 *   added, a unit per name copied. (Functions do not nest, V30 refusing a nested one, so the inherited set is empty;
 *   the copy is charged all the same);
 * - at a call, the parentheses `unwrap` strips from its callee (the collector reads the callee so): a unit each;
 * - the marking of the ancestors of each call read: a unit per ancestor marked;
 * - the rebuild: a unit per container walked, from the last met to the first, and a unit per member a changed container
 *   maps.
 */
function viewProgram(
  program: Program,
  eligible: (name: string) => boolean,
  back: Map<SyntaxNode, SyntaxNode>,
  forth: Map<SyntaxNode, SyntaxNode>,
): { readonly program: Program; readonly calls: number; readonly steps: number } {
  // every container once, before its contents (a tree: each has one holder), the place slots below each, and the calls
  // the view reads
  const order: unknown[] = [];
  const holders = new Map<unknown, unknown>();
  const places = new Set<unknown>();
  const reads = new Set<CallExpression>();
  let steps = 0;
  const stack: Visit[] = [{ value: program, holder: null, shadowed: new Set() }];
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    steps += 1;
    const { value, holder } = visit;
    if (value === null || typeof value !== "object" || holders.has(value)) continue;
    holders.set(value, holder);
    order.push(value);
    let shadowed = visit.shadowed;
    if (isFunction(value)) {
      const own = ownNames(value);
      steps += own.steps + shadowed.size + own.names.length;
      shadowed = new Set([...shadowed, ...own.names]);
    }
    if (isNode(value)) {
      const slots = placeSlots(value, places.has(value));
      steps += slots.steps;
      for (const slot of slots.slots) places.add(slot);
    }
    if (
      isCall(value) &&
      !places.has(value) &&
      readsAsArgument(value, (name) => eligible(name) && !shadowed.has(name))
    )
      reads.add(value);
    for (const [key, child] of Object.entries(value))
      if (key !== "span") stack.push({ value: child, holder: value, shadowed });
  }
  if (reads.size === 0) return { program, calls: 0, steps };
  // the containers on the way to a call the view reads, each rebuilt after its contents
  const changed = new Set<unknown>();
  for (const call of reads)
    for (let at: unknown = call; at !== null && !changed.has(at); at = holders.get(at) ?? null) {
      steps += 1;
      changed.add(at);
    }
  // (each changed container's copy; any other value is kept)
  const rebuilt = new Map<unknown, object>();
  for (let at = order.length - 1; at >= 0; at -= 1) {
    const value = order[at];
    steps += 1;
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
    } else if (Array.isArray(value)) {
      steps += value.length;
      rebuilt.set(
        value,
        value.map((child) => rebuilt.get(child) ?? child),
      );
    } else if (value !== null && typeof value === "object") {
      const members = Object.entries(value);
      steps += members.length;
      const copy = Object.fromEntries(
        members.map(([key, child]) => [key, rebuilt.get(child) ?? child]),
      );
      if (isNode(value) && isNode(copy)) {
        back.set(copy, value);
        forth.set(value, copy);
      }
      rebuilt.set(value, copy);
    }
  }
  return { program: viewedProgram(rebuilt.get(program)), calls: reads.size, steps };
}

/**
 * The place slots directly below `node`, `held` where `node` stands in one (#2493, r4-452): the slots through which a
 * write reaches, a store's target's receiver and the receiver of a method that changes it, its callee read through
 * parentheses, and below a slot, what parentheses hold and a property's or an element's receiver; with the parentheses
 * stripped from a callee, a unit each. The analysis's readers that take a parenthesized
 * expression for its place read these slots only, as a write's; a test reads its subject's value, which a call's result
 * shares with its argument when it runs (the inventory in tests/type-core/type-core-identity.test.ts).
 */
function placeSlots(
  node: SyntaxNode,
  held: boolean,
): { readonly slots: readonly unknown[]; readonly steps: number } {
  const value = syntaxOf(node);
  switch (value.kind) {
    case "parenthesizedExpression":
      return { slots: held ? [value.expression] : [], steps: 0 };
    case "propertyAccessExpression":
    case "indexExpression":
      return { slots: held ? [value.object] : [], steps: 0 };
    case "assignmentStatement":
      return { slots: value.target.kind === "identifier" ? [] : [value.target.object], steps: 0 };
    case "callExpression": {
      // (the collector reads a method through the parentheses around its callee: `(xs.add)(1)` changes `xs`)
      const callee = unwrap(value.callee);
      let steps = 0;
      for (
        let at = value.callee;
        at !== callee && at.kind === "parenthesizedExpression";
        at = at.expression
      )
        steps += 1;
      return {
        slots:
          callee.kind === "propertyAccessExpression" && changesReceiver(callee.property.name)
            ? [callee.object]
            : [],
        steps,
      };
    }
    default:
      return { slots: [], steps: 0 };
  }
}

/** Whether a method of `name` changes its receiver: a list's, a set's or a dict's that changes it, or `copyFrom`. */
function changesReceiver(name: string): boolean {
  return listMethod(name)?.changes !== undefined || changesEntries(name) || name === "copyFrom";
}

/** The view's copy of an expression. */
function viewed(value: unknown): Expression {
  // EVIDENCE: invariant: an expression's copy keeps its kind and members, or is the parentheses that read a call.
  return value as Expression;
}

/** A node the walk meets, as the syntax it is a node of. */
function syntaxOf(node: SyntaxNode): Expression | Statement {
  // EVIDENCE: invariant: the walk meets only a program's nodes; a kind outside these two unions has no place slot.
  return node as Expression | Statement;
}

/** The view's copy of a program. */
function viewedProgram(value: unknown): Program {
  // EVIDENCE: invariant: a program's copy keeps its kind and members, its calls read as parentheses.
  return value as Program;
}

/**
 * The names a function declares for its body: its parameters, its variables and its loop variables; with the values
 * walked to find them.
 */
function ownNames(declaration: FunctionDeclaration): {
  readonly names: readonly string[];
  readonly steps: number;
} {
  const names = declaration.parameters.map((parameter) => parameter.name.name);
  const stack: unknown[] = [declaration.body];
  let steps = names.length;
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    steps += 1;
    if (value === null || typeof value !== "object") continue;
    if (isLet(value)) names.push(value.name.name);
    if (isFor(value)) {
      names.push(value.variable.name);
      if (value.valueVariable !== null) names.push(value.valueVariable.name);
    }
    for (const [key, child] of Object.entries(value)) if (key !== "span") stack.push(child);
  }
  return { names, steps };
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
