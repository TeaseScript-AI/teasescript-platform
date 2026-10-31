import type { Expression, ObjectProperty, Statement } from "../../../ast.js";
import {
  changesAnything,
  type EffectFacts,
  functionEffects,
  methodEffects,
} from "../../../runtime/evaluation/effect-facts.js";
import type { SourceSpan } from "../../../source.js";
import type { SourceSite } from "../../graph.js";
import { expressionParts, statementExpressions } from "../../../expression-children.js";
import { listDraw } from "../../../list-methods.js";
import type { ItemTag } from "../items.js";
import type { CheckedDiagnostic, StoreStep } from "../result.js";

// How a message names the source, and the syntax around a site it reads: checks that hold, parts, acts, landings.

/**
 * How a message names the source and what it knows of the analysis: the text at a site, the line it starts on
 * (1-based), its column (0-based), the statement a check may hold, and whether an author's text lies clear of the
 * analysis's other diagnostics, the fact `codeAt` reads of every form that holds it.
 */
export interface MessageSource {
  readonly text: (site: SourceSite) => string;
  readonly line: (site: SourceSite) => number;
  readonly column: (site: SourceSite) => number;
  /**
   * The statement a check may hold, as in `if n != null { say n + 1 }`, for the use at `use` of the value at `read`
   * inside it: the innermost statement around the use that is one of a block's or a file's statements, on one line,
   * where a check before it still holds at the use (`evaluation`); else `null`.
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
   * Whether no diagnostic of the analysis but `self` lies in the author's text at `held` (TABLE r4.162): none at a
   * site in it, nor a "not checked (budget)" mark whose region reaches into it, where the checks the stop moved to the
   * runtime stand unreported (Astra r3; a stop's own warning claims no region); apart from one at `self`'s site whose
   * every type `rulesOut` rules out (beside a null check a type test, beside a form's value the replaced value's own).
   * `codeAt`'s "no other diagnostic" fact.
   */
  readonly alone: (
    self: CheckedDiagnostic,
    held: SourceSite,
    rulesOut: ((kind: ItemTag) => boolean) | null,
  ) => boolean;
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

const EVALUATIONS = new WeakMap<Statement, Evaluation>();

function evaluation(statement: Statement): Evaluation {
  const known = EVALUATIONS.get(statement);
  if (known !== undefined) return known;
  const lazy: boolean[] = [];
  const first: number[] = [];
  const acting = [0];
  const at = new Map<string, number>();
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
  EVALUATIONS.set(statement, prepared);
  return prepared;
}

/**
 * Whether a check before `statement` still holds at the use at `use` of the value at `read` (#1268, Codex r4 and r5):
 * the statement evaluates the use whenever it runs (not after `and`, `or` or `otherwise`, nor in a `default:`), and
 * nothing it evaluates before the use, apart from the value read, may change or draw anything (`effect-facts.ts`), so
 * the check sees what the use sees and a value kept before it is the one the use would read. A value read that may
 * itself change or draw, the read included, is kept before the statement only where it is the first thing evaluated, so
 * that no draw or read before it, a text's placeholder's included, moves behind it.
 */
export function guards(statement: Statement, use: SourceSite, read: SourceSite): boolean {
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

/** Where a value lands (`MessageSource.landing`): the variable it is given to, and the steps from it to the value. */
export interface Landing {
  readonly root: string;
  readonly steps: readonly StoreStep[];
}

/** A value a statement gives its variable (`MessageSource.landing`): the value, the variable and its steps. */
export interface Given {
  readonly value: Expression;
  readonly root: string;
  readonly steps: readonly StoreStep[];
}

/** The variable and the properties an assignment's target names (`box.inner`), else `null`. */
function targetSteps(target: Expression): Landing | null {
  const steps: StoreStep[] = [];
  let at = target;
  while (at.kind === "propertyAccessExpression") {
    steps.unshift({ property: at.property.name });
    at = at.object;
  }
  return at.kind === "identifier" ? { root: at.name, steps } : null;
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

/**
 * Where the expression at `site` lands among the values statements give (`MessageSource.landing`, in their start order):
 * in the last value that starts at or before it, the statement's variable and steps, then each list literal's element
 * and object literal's property down to it, through parentheses; `null` inside any other expression, or outside that
 * value (a site after a statement in a handler block that a value holds).
 */
export function landingOf(given: readonly Given[], site: SourceSite): Landing | null {
  let low = 0;
  let high = given.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (given[middle]!.value.span.start.offset <= site.start) low = middle + 1;
    else high = middle;
  }
  const found = given[low - 1];
  if (found === undefined) return null;
  const holds = (expression: Expression): boolean =>
    expression.span.start.offset <= site.start && site.end <= expression.span.end.offset;
  const steps = [...found.steps];
  let at: Expression | undefined = found.value;
  while (at !== undefined && holds(at)) {
    if (at.span.start.offset === site.start && at.span.end.offset === site.end)
      return { root: found.root, steps };
    if (at.kind === "parenthesizedExpression") at = at.expression;
    else if (at.kind === "listLiteral") {
      steps.push({ collection: "list" });
      at = at.elements.find(holds);
    } else if (at.kind === "objectLiteral") {
      const property: ObjectProperty | undefined = at.properties.find((entry) =>
        holds(entry.value),
      );
      if (property !== undefined) steps.push({ property: property.name.name });
      at = property?.value;
    } else return null;
  }
  return null;
}
