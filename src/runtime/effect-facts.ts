import { isConversion } from "../conversions.js";
import { dictMethod } from "../dict-operations.js";
import { kindsWithMethod, kindsWithProperty } from "../handle-members.js";
import { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "../language-facts.js";
import { isListFunction } from "../list-function-rules.js";
import { listDraw, listMethod } from "../list-methods.js";
import { isNumericFunction } from "../numeric-functions.js";
import { expressionPlanChildren } from "../plan/expression-children.js";
import type { ExpressionPlan } from "../plan/model.js";
import { isRandomFunction } from "../random-functions.js";
import { isClockFunction, isTemporalMethod } from "../temporal-builtins.js";
import { isTextMethod } from "../text-operations.js";
import type { RuntimeDebugRandomOperation } from "./debug-trace.js";

/*
 * The runtime's conservative facts about what evaluating an expression may do besides giving its value, taken from the
 * contracts of the operations it calls. Three questions read them, each its own way: whether an operand must be copied
 * before a later call may change it (`evaluator.ts`), whether a say can stage on copies of only the parts it changes
 * (`say-staging.ts`), and whether a unit must copy the state to undo a change before a later draw (`random-control.ts`).
 * Every kind of expression, core function, and family of methods has its decision here, and anything else counts as
 * possibly doing everything.
 */

/** What evaluating one node of an expression may do itself, after its children. */
export interface EffectFacts {
  /** It may change a value in place, which every holder of the value sees, such as a list's `add` or a handle method. */
  readonly changesValue: boolean;
  /** It may change other state, which no value shows, such as the temporary that holds a prepared reference. */
  readonly changesState: boolean;
  /** It may draw from the session generator. */
  readonly draws: boolean;
  /** Its draw may follow a change of its own, as a timer's `pause()` may end a round that is due and draw the next. */
  readonly drawsAfterChange: boolean;
}

const PURE: EffectFacts = facts(false, false, false, false);
const DRAWS: EffectFacts = facts(false, false, true, false);
const CHANGES_STATE: EffectFacts = facts(false, true, false, false);
/** The answer for an operation whose effects the engine does not know. */
const ANY: EffectFacts = facts(true, true, true, true);

function facts(
  changesValue: boolean,
  changesState: boolean,
  draws: boolean,
  drawsAfterChange: boolean,
): EffectFacts {
  return Object.freeze({ changesValue, changesState, draws, drawsAfterChange });
}

/** Whether `facts` may change anything but the session generator. */
export function changesAnything(facts: EffectFacts): boolean {
  return facts.changesValue || facts.changesState;
}

/** What evaluating `node` may do itself, apart from its children. Every kind of expression has its case. */
export function expressionEffects(node: ExpressionPlan): EffectFacts {
  switch (node.kind) {
    case "call":
      if (node.callee.kind === "identifier") return functionEffects(node.callee.name);
      if (node.callee.kind === "property") return methodEffects(node.callee.name);
      return ANY;
    // A list read of `random` draws, whatever value it turns out to be read from.
    case "property":
    case "tagQuery":
      return drawKind(node) === null ? PURE : DRAWS;
    // Each placeholder that holds a list draws; a conservative reading draws after all of them.
    case "template":
      return node.parts.some((part) => part.kind === "expression") ? DRAWS : PURE;
    // Reading a prepared reference can detach it, which changes the temporary that holds it.
    case "preparedReference":
      return CHANGES_STATE;
    // A lookup may build a key index of a dict it reads, which is derived from entries it does not change.
    case "index":
    case "literal":
    case "regex":
    case "duration":
    case "calendarDuration":
    case "identifier":
    case "debugMode":
    case "accountField":
    case "list":
    case "object":
    case "set":
    case "dict":
    case "group":
    case "unary":
    case "unit":
    case "angleUnit":
    case "binary":
    case "range":
    case "temporary":
    case "storageLoad":
    case "typeTest":
      return PURE;
    default:
      return unknown(node);
  }
}

type CoreFunctionName =
  (typeof CORE_RUNTIME_BUILTINS)[number] | (typeof PLATFORM_STANDARD_LIBRARY_PRELUDE)[number];

function isCoreFunction(name: string): name is CoreFunctionName {
  return (
    CORE_RUNTIME_BUILTINS.some((builtin) => builtin === name) ||
    PLATFORM_STANDARD_LIBRARY_PRELUDE.some((builtin) => builtin === name)
  );
}

/**
 * What a call of the function `name` may do. The random functions draw; the conversions, the numeric and angle
 * functions, the list functions, and the clock reads only read copies of their arguments and return a new value, as do
 * `hashText`, `script`, and `escapeMarkup`. A host built-in runs code the engine has not checked.
 */
export function functionEffects(name: string): EffectFacts {
  if (!isCoreFunction(name)) return ANY;
  if (isRandomFunction(name)) return DRAWS;
  if (
    isConversion(name) ||
    isNumericFunction(name) ||
    isListFunction(name) ||
    isClockFunction(name)
  )
    return PURE;
  switch (name) {
    case "hashText":
    case "script":
    case "escapeMarkup":
      return PURE;
    // These run as `fileStore` and `lock` instructions, and a valid plan holds no call of one.
    case "fileFromBase64":
    case "fileToBase64":
    case "hashFile":
    case "encryptText":
    case "encryptFile":
    case "decryptText":
    case "decryptFile":
      return ANY;
    default:
      return unknown(name);
  }
}

/**
 * What a call of the method `name` may do on any value that has a method of that name: a list or set method changes its
 * receiver and draws as its contract says (see `ListMethod`), a dict method changes its entries as its contract says
 * (see `DictMethod`), every handle method changes its handle and may then draw (see `HandleMethod`), and text and date
 * and time values have only reading methods. A name that no value has may do anything.
 */
export function methodEffects(name: string): EffectFacts {
  const list = listMethod(name);
  const dict = dictMethod(name);
  const handles = kindsWithMethod(name);
  if (
    list === undefined &&
    dict === undefined &&
    handles.length === 0 &&
    !isTextMethod(name) &&
    !isTemporalMethod(name)
  )
    return ANY;
  const handleDraws = kindsWithMethod(name, (method) => method.draws === true).length > 0;
  return facts(
    list?.changes !== undefined || dict?.changes !== undefined || handles.length > 0,
    false,
    list?.draws !== undefined || handleDraws,
    handleDraws,
  );
}

/**
 * Whether assigning the property `name` may draw from the session generator, after the write: a timer's `remaining`
 * may end its round, which draws the next one (see `HandleProperty.draws`).
 */
export function writeDraws(name: string): boolean {
  return kindsWithProperty(name, (property) => property.draws === true).length > 0;
}

/**
 * The draw that evaluating `node` takes itself, named as a debug trace names it: a random function's, a list or set
 * method's or property's (see `listDraw`), or a random tag query's; otherwise `null`. A template's placeholders and a
 * timer's rounds draw as well.
 */
export function drawKind(node: ExpressionPlan): RuntimeDebugRandomOperation | null {
  if (node.kind === "call") {
    if (node.callee.kind === "identifier" && isRandomFunction(node.callee.name))
      return node.callee.name;
    if (node.callee.kind === "property") return listDraw(node.callee.name, "method") ?? null;
    return null;
  }
  if (node.kind === "property") return listDraw(node.name, "property") ?? null;
  if (node.kind === "tagQuery" && node.select === "random") return "tagQuery";
  return null;
}

/**
 * The answer for a kind or name without its case, which may do anything. Its parameter has type `never`, so a kind or
 * name added without its case fails to compile.
 */
function unknown(_kind: never): EffectFacts {
  return ANY;
}

/** The children of `node` that evaluating it evaluates, in evaluation order: a method's callee only by its receiver. */
export function evaluatedChildren(node: ExpressionPlan): readonly ExpressionPlan[] {
  if (node.kind === "call" && node.callee.kind === "property")
    return [node.callee.object, ...node.arguments.map((argument) => argument.value)];
  if (node.kind === "call") return node.arguments.map((argument) => argument.value);
  return expressionPlanChildren(node);
}
