import type {
  CallExpression,
  DictEntry,
  Expression,
  FunctionDeclaration,
  FunctionParameter,
  ListLiteral,
  ObjectLiteral,
  ObjectProperty,
  SetLiteral,
  Statement,
  TypeAnnotation,
} from "../../../ast.js";
import { selectsElement } from "../method-categories.js";
import {
  changesAnything,
  type EffectFacts,
  functionEffects,
  methodEffects,
} from "../../../runtime/evaluation/effect-facts.js";
import type { SourceSpan } from "../../../source.js";
import type { SourceSite } from "../../graph.js";
import { expressionParts, statementExpressions } from "../../../expression-children.js";
import { listDraw, listMethod } from "../../../list-methods.js";
import type { ItemTag } from "../items.js";
import type { CheckedDiagnostic, StoreStep } from "../result.js";
import { Retained, retainedModule } from "../retained/retained.js";

// How a message names the source, and the syntax around a site it reads: checks that hold, parts, acts, landings.

/**
 * What a message reads of the source and of the analysis: the text at a site, the line it starts on (1-based), its
 * column (0-based), the statement a check may hold, whether a site is a store's target, where a value lands, a
 * declaration's written type, the expression that owns a property, whether an author's text lies clear of the
 * analysis's other diagnostics (the fact `codeAt` reads of every form that holds it), and a free name for a kept value.
 * Its one implementation is `messageSource` (`messages.ts`), which imports the sentence modules that take this
 * interface; so it is declared here, beside the syntax its members read.
 */
export interface MessageSource {
  readonly text: (site: SourceSite) => string;
  readonly line: (site: SourceSite) => number;
  readonly column: (site: SourceSite) => number;
  /**
   * The statement a check may hold, as in `if n != null { say n + 1 }`, for the use at `use` of the value at `read`
   * inside it: the innermost statement around the use that is one of a block's or a file's statements, on one line,
   * where a check before it still holds at the use (`checkBeforeCoversUse`); else `null`.
   */
  readonly statement: (use: SourceSite, read: SourceSite) => SourceSite | null;
  /** Whether a site is the place an assignment on its line stores into, or a receiver on its path (`inTarget`). */
  readonly target: (site: SourceSite) => boolean;
  /**
   * Where the value at `site` lands (#1468), by the syntax around it: the variable a `let`, a `global` or an `=` gives
   * it to, and the steps from that variable to it (a property an object literal or the assignment's target names, a
   * list literal's element); `null` where it lands any other way.
   */
  readonly landing: (site: SourceSite) => Landing | null;
  /**
   * The written type of the declaration at `site` (a `let`, a `global` or a parameter, as a store's root names it), as
   * the parser read it; `null` where it has none (#1753).
   */
  readonly declared: (site: SourceSite) => TypeAnnotation | null;
  /** The narrowest expression that owns the property `steps` lead to below the value at `site` (`ownerOf`, #1495). */
  readonly owner: (site: SourceSite, steps: readonly StoreStep[]) => SourceSite;
  /**
   * Whether no diagnostic of the analysis but `self` lies in the author's text at `held`: none at a
   * site in it, nor a "not checked (budget)" mark whose region reaches into it, where the checks the stop moved to the
   * runtime stand unreported (a stop's own warning claims no region); apart from one at `self`'s site whose
   * every type `rulesOut` rules out (beside a null check a type test, beside a form's value the replaced value's own).
   * `codeAt`'s "no other diagnostic" fact.
   */
  readonly alone: (
    self: CheckedDiagnostic,
    held: SourceSite,
    rulesOut: ((kind: ItemTag) => boolean) | null,
  ) => boolean;
  /**
   * A name a fix may declare anywhere in the project (#1274): `base`, else `base2`, `base3`, …, the first that no
   * identifier of any file's code spells (a property's name aside) and no host global or built-in name reserves. A
   * declaration of the name anywhere would spell it, so it duplicates no visible name wherever the fix is pasted.
   */
  readonly freeName: (base: string) => string;
}

/**
 * The statements a check may not hold: a name or a label one declares would end with the check's block, a return
 * there could end its function without a value, and a `while` tests its condition again after each pass, where a check
 * before it no longer holds.
 */
export const UNGUARDED: ReadonlySet<Statement["kind"]> = new Set([
  "letStatement",
  "globalStatement",
  "functionDeclaration",
  "speakerDeclaration",
  "labelStatement",
  "returnStatement",
  "whileStatement",
]);

/** A line's statements on one line: in start order, the outer first, each with the index of the next one around it. */
export interface LineStatements {
  readonly statements: Statement[];
  readonly around: number[];
}

/** Whether a span holds a site. */
export const holds = ({ start, end }: SourceSpan, site: SourceSite): boolean =>
  start.offset <= site.start && site.end <= end.offset;

/**
 * Whether a site is an assignment's target or a receiver on its path: the place the store changes, which a check or a
 * fallback may not replace (an index or a key the target reads is a value of its own).
 */
export function inTarget(statement: Statement, site: SourceSite): boolean {
  if (statement.kind !== "assignmentStatement") return false;
  for (let at: Expression = statement.target; ;) {
    if (at.span.start.offset === site.start && at.span.end.offset === site.end) return true;
    if (at.kind === "propertyAccessExpression" || at.kind === "indexExpression") at = at.object;
    else if (at.kind === "parenthesizedExpression") at = at.expression;
    else return false;
  }
}

/** A site's key among a statement's nodes. */
const spanKey = (start: number, end: number): string => `${start}:${end}`;

/**
 * What a statement evaluates, in evaluation order (`expression-children.ts`), each node after its parts: whether a run
 * may skip it, whether it may change or draw anything itself (`acts`), and where its own parts begin. Prepared once per
 * statement, for each of its uses.
 */
interface Evaluation {
  readonly lazy: boolean[];
  readonly first: number[];
  /** How many nodes before each index act. */
  readonly acting: number[];
  /** The last node at each site. */
  readonly at: Map<string, number>;
}

const EVALUATIONS = retainedModule<Statement, Evaluation>("site.EVALUATIONS", "weakMap");

function evaluation(statement: Statement): Evaluation {
  const known = EVALUATIONS().get(statement);
  if (known !== undefined) return known;
  const lazy: boolean[] = [];
  const first: number[] = [];
  const acting = [0];
  const at = Retained.map<string, number>("site.EVALUATIONS.at");
  const add = (node: Expression, skipped: boolean, start: number): void => {
    const index = lazy.length;
    lazy.push(skipped);
    first.push(start);
    acting.push(acting[index]! + (acts(node) ? 1 : 0));
    at.set(spanKey(node.span.start.offset, node.span.end.offset), index);
  };
  type Work =
    | { readonly node: Expression; readonly lazy: boolean; readonly parts: true }
    | {
        readonly node: Expression;
        readonly lazy: boolean;
        readonly parts: false;
        readonly start: number;
      };
  const work: Work[] = statementExpressions(statement)
    .map((node): Work => ({ node, lazy: false, parts: true }))
    .reverse();
  for (let entry = work.pop(); entry !== undefined; entry = work.pop()) {
    if (!entry.parts) {
      add(entry.node, entry.lazy, entry.start);
      continue;
    }
    const { node } = entry;
    const start = lazy.length;
    work.push({ node, lazy: entry.lazy, parts: false, start });
    for (const part of partsOf(node, entry.lazy).toReversed()) work.push({ ...part, parts: true });
  }
  // (a store through a member or an index takes effect after its value)
  if (statement.kind === "assignmentStatement" && statement.target.kind !== "identifier")
    add(statement.target, false, 0);
  const prepared = { lazy, first, acting, at };
  EVALUATIONS().set(statement, prepared);
  return prepared;
}

/**
 * Whether a check before `statement` still holds at the use at `use` of the value at `read` (#1268):
 * the statement evaluates the use whenever it runs (not after `and`, `or` or `otherwise`, nor in a `default:`), and
 * nothing it evaluates before the use, apart from the value read, may change or draw anything (`effect-facts.ts`), so
 * the check sees what the use sees and a value kept before it is the one the use would read. A value read that may
 * itself change or draw, the read included, is kept before the statement only where it is the first thing evaluated, so
 * that no draw or read before it, a text's placeholder's included, moves behind it.
 */
export function checkBeforeCoversUse(
  statement: Statement,
  use: SourceSite,
  read: SourceSite,
): boolean {
  const { lazy, first, acting, at } = evaluation(statement);
  const used = at.get(spanKey(use.start, use.end));
  const value = at.get(spanKey(read.start, read.end));
  if (used === undefined || value === undefined || lazy[used]) return false;
  // (the value read, its parts first, inside the use's own)
  const from = first[value]!;
  if (from < first[used]! || value > used) return false;
  // (before the value, and between it and the use, which evaluates its other parts there)
  const between = used > value ? acting[used]! - acting[value + 1]! : 0;
  const kept = acting[value + 1]! - acting[from]!;
  return (
    acting[from]! + between === 0 && (kept === 0 || from + Math.max(used - value - 1, 0) === 0)
  );
}

/** The operators whose right operand only some runs evaluate. */
const LAZY_RIGHT: ReadonlySet<string> = new Set(["and", "or", "otherwise"]);

/**
 * The parts of an expression in evaluation order (`expressionParts`), each with whether a run may skip it: the right
 * operand of `and`, `or` and `otherwise`, a `default:`.
 */
function partsOf(
  node: Expression,
  lazy: boolean,
): { readonly node: Expression; readonly lazy: boolean }[] {
  if (node.kind === "callExpression")
    return [
      { node: node.callee, lazy },
      ...(node.presentation === undefined ? [] : [{ node: node.presentation, lazy }]),
      ...node.arguments.map((argument) => ({
        node: argument.value,
        lazy: lazy || (argument.kind === "namedArgument" && argument.name.name === "default"),
      })),
    ];
  if (node.kind === "binaryExpression" && LAZY_RIGHT.has(node.operator))
    return [
      { node: node.left, lazy },
      { node: node.right, lazy: true },
    ];
  if (node.kind === "loadExpression")
    return [
      { node: node.key, lazy },
      ...(node.defaultValue === null ? [] : [{ node: node.defaultValue, lazy: true }]),
    ];
  return expressionParts(node).map((part) => ({ node: part, lazy }));
}
/**
 * Whether evaluating `node` itself may change or draw anything, as `effect-facts.ts` decides it for the runtime: a call
 * by its function or method, a read of a list's `random`, a text with values in it, a tag query; an ask, a say or
 * another command; anything else, a read, is pure.
 */
function acts(node: Expression): boolean {
  const effects = (facts: EffectFacts): boolean => changesAnything(facts) || facts.draws;
  switch (node.kind) {
    case "callExpression":
      return node.callee.kind === "identifier"
        ? effects(functionEffects(node.callee.name))
        : node.callee.kind === "propertyAccessExpression"
          ? effects(methodEffects(node.callee.property.name))
          : true;
    case "propertyAccessExpression":
      return listDraw(node.property.name, "property") !== undefined;
    case "stringLiteral":
      return node.parts.some((part) => part.kind === "stringInterpolation");
    case "identifier":
    case "numberLiteral":
    case "booleanLiteral":
    case "nullLiteral":
    case "durationLiteral":
    case "regexLiteral":
    case "parenthesizedExpression":
    case "listLiteral":
    case "setLiteral":
    case "objectLiteral":
    case "dictLiteral":
    case "indexExpression":
    case "unaryExpression":
    case "unitExpression":
    case "angleExpression":
    case "binaryExpression":
    case "rangeExpression":
    case "typeTestExpression":
    case "loadExpression":
      return false;
    default:
      return true;
  }
}

/**
 * A step from a landing's variable down to the value: a store's step, or an index, which takes a list's element or a
 * dict's value alike (#1763: `a[0] = …`, whichever the variable holds).
 */
export type LandingStep = StoreStep | { readonly index: true } | { readonly member: true };

/**
 * Where a value lands (`MessageSource.landing`): the variable it is given to, or for an argument the parameter (#1763),
 * and the steps from it to the value.
 */
export interface Landing {
  readonly root: string;
  readonly steps: readonly LandingStep[];
  /**
   * A storing method's argument (`add`'s `element`, `addAll`'s `elements`): a landing that does not reach the place,
   * or a receiver no name reaches (no `root`), proves no level of it (`wholeCheck`, #1817).
   */
  readonly method?: "element" | "elements";
}

/** A value a statement gives its variable, or a call its parameter (`MessageSource.landing`): the value, its landing. */
export interface Given extends Landing {
  readonly value: Expression;
}

/** The variable and the properties and indices an assignment's target names (`box.inner`, `a[0]`), else `null`. */
function targetSteps(target: Expression): Landing | null {
  const steps: LandingStep[] = [];
  let at = target;
  // (through parentheses too, #1817: `(a)[0] = …`)
  for (;;) {
    if (at.kind === "parenthesizedExpression") at = at.expression;
    else if (at.kind === "propertyAccessExpression" || at.kind === "indexExpression") {
      steps.push(at.kind === "indexExpression" ? { index: true } : { property: at.property.name });
      at = at.object;
    } else break;
  }
  return at.kind === "identifier" ? { root: at.name, steps: steps.reverse() } : null;
}

/**
 * The values a call gives (#1763): each argument, positional by its place, named by its name, to the parameter of the
 * function the callee names (`resolve`); and the value a list's or a set's storing method stores (`decides`,
 * #1817): `add`'s, a member of its receiver (`{ member: true }`, its element), `addAll`'s, its receiver whole, where
 * the receiver is a variable's place (`targetSteps`), else no name (`root` empty); each marked by its method. A callee
 * is read through parentheses (`(a.add)(x)`, #1817). A method is never the user function of its name.
 * Appended to `out`, so a source's many arguments are never spread into one call (#1817).
 */
export function givenByCall(
  call: CallExpression,
  resolve: (name: string) => FunctionDeclaration | null,
  out: Given[],
): void {
  let callee = call.callee;
  while (callee.kind === "parenthesizedExpression") callee = callee.expression;
  if (callee.kind === "propertyAccessExpression") {
    const method = listMethod(callee.property.name);
    if (method?.decides !== "element" && method?.decides !== "elements") return;
    const name = method.parameters[0]?.name;
    const argument = call.arguments.find((each, position) =>
      each.kind === "namedArgument" ? each.name.name === name : position === 0,
    );
    if (argument === undefined) return;
    const receiver = targetSteps(callee.object) ?? { root: "", steps: [] };
    out.push({
      value: argument.value,
      root: receiver.root,
      steps: method.decides === "element" ? [...receiver.steps, { member: true }] : receiver.steps,
      method: method.decides,
    });
    return;
  }
  const declared = callee.kind === "identifier" ? resolve(callee.name) : null;
  if (declared === null) return;
  const named = parametersByName(declared);
  call.arguments.forEach((argument, position) => {
    const parameter =
      argument.kind === "namedArgument"
        ? named.get(argument.name.name)
        : declared.parameters[position];
    if (parameter !== undefined)
      out.push({ value: argument.value, root: parameter.name.name, steps: [] });
  });
}

/** Each declaration's parameters by name, made on its first named argument (#1817: no search per one). */
const PARAMETERS = retainedModule<FunctionDeclaration, ReadonlyMap<string, FunctionParameter>>(
  "site.PARAMETERS",
  "weakMap",
);

function parametersByName(declared: FunctionDeclaration): ReadonlyMap<string, FunctionParameter> {
  let named = PARAMETERS().get(declared);
  if (named === undefined)
    PARAMETERS().set(
      declared,
      (named = Retained.map(
        "site.PARAMETERS[]",
        declared.parameters.map((each) => [each.name.name, each] as const),
      )),
    );
  return named;
}

/**
 * The values calls give their parameters, in start order, and each one's nearest argument around it (`-1` for none):
 * arguments nest, one call's inside another's (`f(g(x))`), so a search climbs out from the last that starts at or
 * before a site.
 */
export interface Arguments {
  readonly given: readonly Given[];
  readonly around: readonly number[];
}

/** `Arguments` of a file's calls' values, sorted by start, each one's nearest argument around it found by a stack. */
export function argumentsOf(given: Given[]): Arguments {
  given.sort((a, b) => a.value.span.start.offset - b.value.span.start.offset);
  const around: number[] = [];
  const open: number[] = [];
  given.forEach((entry, at) => {
    const end = entry.value.span.end.offset;
    while (open.length > 0 && given[open.at(-1)!]!.value.span.end.offset < end) open.pop();
    around.push(open.at(-1) ?? -1);
    open.push(at);
  });
  return { given, around };
}

/** The value a `let`, a `global` or an `=` statement gives its variable, else `null`. */
export function givenBy(statement: Statement): Given | null {
  if (statement.kind === "letStatement")
    return { value: statement.initializer, root: statement.name.name, steps: [] };
  if (statement.kind === "globalStatement")
    return { value: statement.initial, root: statement.name.name, steps: [] };
  if (statement.kind !== "assignmentStatement" || statement.operator !== "=") return null;
  const target = targetSteps(statement.target);
  return target === null ? null : { value: statement.value, ...target };
}

/** The last of `items`, in source order, whose span starts at or before `start` (a binary search), else `undefined`. */
function lastStartingBy<T>(
  items: readonly T[],
  start: number,
  spanOf: (item: T) => SourceSpan,
  charge: Charge,
): T | undefined {
  return lastStarting(items, start, spanOf, charge).item;
}

/** `lastStartingBy` with its index, `-1` for none: each item compared read once. */
function lastStarting<T>(
  items: readonly T[],
  start: number,
  spanOf: (item: T) => SourceSpan,
  charge: Charge,
): { readonly at: number; readonly item: T | undefined } {
  let low = 0;
  let high = items.length;
  let at = -1;
  let item: T | undefined;
  while (low < high) {
    // (one unit per item compared)
    charge(1);
    const middle = (low + high) >> 1;
    const each = items[middle]!;
    if (spanOf(each).start.offset <= start) {
      at = middle;
      item = each;
      low = middle + 1;
    } else high = middle;
  }
  return { at, item };
}

/**
 * Where a message's walk of the source counts its work (#1730): one unit per item a search
 * compares, per expression the walk descends through, per parenthesis a selection's list or an owner's step unwraps,
 * per property an owner's index holds and per step it takes.
 */
export type Charge = (units: number) => void;

const NO_CHARGE: Charge = () => {};

/**
 * The value at `site` among the values statements give (in their start order), with the statement's variable and the
 * steps down to it: in the last value that starts at or before it, each list or set literal's element, object literal's
 * property and dict literal's value down to it (#1827), through parentheses, a list or set literal's selected element
 * and either operand of `otherwise`, each found by its start (#1730: no warning scans the values or a
 * literal's parts before it); `null` inside any other expression (#2255), in a dict literal's key, or outside that value
 * (a site after a statement in a handler block that a value holds).
 */
function valueAt(
  given: readonly Given[],
  site: SourceSite,
  charge: Charge,
): { readonly found: Given; readonly at: Expression; readonly steps: LandingStep[] } | null {
  const found = lastStartingBy(given, site.start, (entry) => entry.value.span, charge);
  return found === undefined ? null : descend(found, site, charge);
}

/** `valueAt` below one value it found: down its literals' parts to `site`, through parentheses and `otherwise`. */
function descend(
  found: Given,
  site: SourceSite,
  charge: Charge,
): { readonly found: Given; readonly at: Expression; readonly steps: LandingStep[] } | null {
  const holds = (expression: Expression | undefined): expression is Expression =>
    expression !== undefined &&
    expression.span.start.offset <= site.start &&
    site.end <= expression.span.end.offset;
  const within = (expressions: readonly Expression[]): Expression | undefined => {
    const part = lastStartingBy(expressions, site.start, (expression) => expression.span, charge);
    return holds(part) ? part : undefined;
  };
  const steps = [...found.steps];
  let at: Expression | undefined = found.value;
  while (holds(at)) {
    charge(1);
    if (at.span.start.offset === site.start && at.span.end.offset === site.end)
      return { found, at, steps };
    if (at.kind === "parenthesizedExpression") at = at.expression;
    else if (at.kind === "listLiteral") {
      steps.push({ collection: "list" });
      at = within(at.elements);
    } else if (at.kind === "objectLiteral") {
      const property: ObjectProperty | undefined = lastStartingBy(
        at.properties,
        site.start,
        (entry) => entry.value.span,
        charge,
      );
      if (property === undefined || !holds(property.value)) return null;
      steps.push({ property: property.name.name });
      at = property.value;
    } else if (at.kind === "setLiteral") {
      // (#1827)
      steps.push({ collection: "set" });
      at = within(at.elements);
    } else if (at.kind === "dictLiteral") {
      // (a dict literal's value, found by its start as an object's property is; a key is no value of it, #1827)
      const entry: DictEntry | undefined = lastStartingBy(
        at.entries,
        site.start,
        (each) => each.value.span,
        charge,
      );
      if (entry === undefined || !holds(entry.value)) return null;
      steps.push({ collection: "dict" });
      at = entry.value;
    } else if (at.kind === "binaryExpression" && at.operator === "otherwise")
      // (either operand of `otherwise` is the value there, no step more)
      at = within([at.left, at.right]);
    else {
      // (a list or set literal's selected element, `[a, b].random`, `set [a, b].random` or `[a, b][0]`: that element
      // is the place, no step more)
      const literal = selectedFrom(at, charge);
      if (literal === null) return null;
      at = within(literal.elements);
    }
  }
  return null;
}

/** Where the expression at `site` lands among the values statements give (`MessageSource.landing`, `valueAt`). */
export function landingOf(
  given: readonly Given[],
  site: SourceSite,
  charge: Charge = NO_CHARGE,
  calls: Arguments = { given: [], around: [] },
): Landing | null {
  const value = valueAt(given, site, charge) ?? argumentAt(calls, site, charge);
  return value === null
    ? null
    : {
        root: value.found.root,
        steps: value.steps,
        ...(value.found.method === undefined ? {} : { method: value.found.method }),
      };
}

/**
 * The value at `site` among the values calls give (#1763): from the last argument that starts at or before it, out
 * through the arguments around it to the first that holds it, then down as `valueAt` goes; `null` in none.
 */
function argumentAt(
  calls: Arguments,
  site: SourceSite,
  charge: Charge,
): { readonly found: Given; readonly at: Expression; readonly steps: LandingStep[] } | null {
  let { at } = lastStarting(calls.given, site.start, (entry) => entry.value.span, charge);
  while (at !== -1) {
    // (one unit per argument climbed out of)
    charge(1);
    const found = calls.given[at]!;
    const { span } = found.value;
    if (span.start.offset <= site.start && site.end <= span.end.offset)
      return descend(found, site, charge);
    at = calls.around[at]!;
  }
  return null;
}

/**
 * The list or set literal a selection of one element reads (`.random`, `.first`, `.last`; a list's index, as a set has
 * none, V30), through parentheses.
 */
function selectedFrom(expression: Expression, charge: Charge): ListLiteral | SetLiteral | null {
  const property =
    expression.kind === "propertyAccessExpression" && selectsElement(expression.property.name);
  const object = property
    ? expression.object
    : expression.kind === "indexExpression"
      ? expression.object
      : null;
  if (object === null) return null;
  let inner = object;
  while (inner.kind === "parenthesizedExpression") {
    // (one unit per parenthesis unwrapped)
    charge(1);
    inner = inner.expression;
  }
  return inner.kind === "listLiteral" || (property && inner.kind === "setLiteral") ? inner : null;
}

/** Each object literal's properties by name, made on its first lookup (`ownerOf`), one unit per property it holds. */
const PROPERTIES = retainedModule<ObjectLiteral, ReadonlyMap<string, ObjectProperty>>(
  "site.PROPERTIES",
  "weakMap",
);

/**
 * The narrowest expression that owns the property `steps` lead to below the value at `site` (#1495): from the value
 * (`valueAt`), each property step taken into an object literal's property of that name, through parentheses, while one
 * is there; the value itself where none is, or where `site` lies in no value a statement gives.
 */
export function ownerOf(
  given: readonly Given[],
  site: SourceSite,
  steps: readonly StoreStep[],
  charge: Charge = NO_CHARGE,
): SourceSite {
  let at = valueAt(given, site, charge)?.at;
  if (at === undefined) return site;
  for (const step of steps) {
    while (at.kind === "parenthesizedExpression") {
      // (one unit per parenthesis unwrapped)
      charge(1);
      at = at.expression;
    }
    if (!("property" in step) || at.kind !== "objectLiteral") break;
    let named = PROPERTIES().get(at);
    if (named === undefined) {
      charge(at.properties.length);
      PROPERTIES().set(
        at,
        (named = Retained.map(
          "site.PROPERTIES[]",
          at.properties.map((entry) => [entry.name.name, entry] as const),
        )),
      );
    }
    const property = named.get(step.property);
    if (property === undefined) break;
    charge(1);
    at = property.value;
  }
  return { file: site.file, start: at.span.start.offset, end: at.span.end.offset };
}
